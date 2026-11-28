// Gemeinsamer Speicher für Hintergrunddienst und Popup: Einstellungen im Klartext, Zugangsdaten verschlüsselt.
//
// Die Zugangsdaten liegen als AES-GCM-Chiffrat in chrome.storage.local. Der Schlüssel ist ein *nicht
// exportierbarer* CryptoKey in IndexedDB: Wer nur die Profil-Dateien kopiert, bekommt das Passwort nicht
// im Klartext. Gegen Code, der in diesem Chrome-Profil als diese Erweiterung läuft, schützt das nicht.

export const OLAT_ORIGIN = 'https://olat.bms-w.ch';

export const DEFAULT_SETTINGS = Object.freeze({
  /** Auf der Login-Seite automatisch anmelden. */
  autoLogin: true,
  /** Die Sitzung alle paar Minuten anfragen, damit OLAT sie nicht wegen Inaktivität beendet. */
  keepAlive: true,
  /** Das Sitzungs-Cookie über einen Browser-Neustart hinweg behalten. */
  persistCookies: true,
});

const AAD = new TextEncoder().encode('olat-autologin-v1');

const toB64 = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Schlüssel-Ablage im Speicher (Tests). */
export function memoryKeyVault() {
  let key = null;
  return { get: async () => key, set: async (k) => void (key = k) };
}

/** Schlüssel-Ablage in IndexedDB. CryptoKeys lassen sich dort als nicht exportierbare Objekte speichern. */
export function idbKeyVault(dbName = 'olat-autologin') {
  const open = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const req = fn(db.transaction('keys', mode).objectStore('keys'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: async () => (await run('readonly', (s) => s.get('aes'))) ?? null,
    set: async (key) => void (await run('readwrite', (s) => s.put(key, 'aes'))),
  };
}

/** Macht aus einem chrome.storage-Bereich eine einfache get/set/remove-Schnittstelle. */
export function chromeStorage(area) {
  return {
    get: async (key) => (await area.get(key))[key],
    set: async (key, value) => void (await area.set({ [key]: value })),
    remove: async (key) => void (await area.remove(key)),
  };
}

export function createStore({ storage, vault }) {
  async function key(create) {
    let k = await vault.get();
    if (!k && create) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await vault.set(k);
    }
    return k;
  }

  return {
    async saveCredentials({ username, password }) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = new TextEncoder().encode(JSON.stringify({ username, password }));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await key(true), plain);
      await storage.set('credentials', { v: 1, iv: toB64(iv), ct: toB64(ct) });
    },

    /** Gibt `null` zurück, wenn nichts gespeichert ist oder sich nichts entschlüsseln lässt (z. B. Schlüssel gelöscht). */
    async getCredentials() {
      const entry = await storage.get('credentials');
      const k = await key(false);
      if (!entry || !k) return null;
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(entry.iv), additionalData: AAD }, k, fromB64(entry.ct));
        const { username, password } = JSON.parse(new TextDecoder().decode(plain));
        return username && password ? { username, password } : null;
      } catch {
        return null;
      }
    },

    clearCredentials: () => storage.remove('credentials'),

    async getSettings() {
      return { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
    },

    async saveSettings(patch) {
      const next = { ...(await this.getSettings()) };
      for (const name of Object.keys(DEFAULT_SETTINGS)) if (typeof patch[name] === 'boolean') next[name] = patch[name];
      await storage.set('settings', next);
      return next;
    },
  };
}
