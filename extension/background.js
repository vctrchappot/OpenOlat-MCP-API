// Hintergrunddienst: hält das Sitzungs-Cookie über Browser-Neustarts, fragt die Sitzung regelmässig an
// und gibt dem Content-Script auf OLAT die Zugangsdaten (nur dort, nur begrenzt oft).
import { OLAT_ORIGIN, chromeStorage, createStore, idbKeyVault } from './store.js';

const OLAT_HOST = new URL(OLAT_ORIGIN).hostname;
const COOKIE_DAYS = 14;
const PING_MINUTES = 5;
const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const LOGOUT_PAUSE_MS = 10 * 60_000;

const store = createStore({ storage: chromeStorage(chrome.storage.local), vault: idbKeyVault() });
const local = chromeStorage(chrome.storage.local);
// storage.session ist für Content-Scripts nicht lesbar und wird beim Schliessen des Browsers geleert.
const session = chromeStorage(chrome.storage.session);

// ---------------------------------------------------------------- Zustand

async function getState() {
  return (await local.get('state')) ?? {};
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await local.set('state', next);
  await updateBadge(next);
  return next;
}

async function updateBadge(state) {
  const failed = Boolean(state.authError);
  await chrome.action.setBadgeText({ text: failed ? '!' : '' });
  if (failed) await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  await chrome.action.setTitle({ title: failed ? 'OLAT Auto-Login: Anmeldung fehlgeschlagen' : 'OLAT Auto-Login' });
}

// ---------------------------------------------------------------- Cookie über den Neustart hinweg behalten

/** Macht aus einem Sitzungs-Cookie (verfällt beim Schliessen von Chrome) ein Cookie mit Ablaufdatum. */
async function persistCookie(cookie) {
  if (!cookie.session || cookie.domain.replace(/^\./, '') !== OLAT_HOST) return;
  if (!(await store.getSettings()).persistCookies) return;
  await chrome.cookies.set({
    url: `${OLAT_ORIGIN}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    storeId: cookie.storeId,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    expirationDate: Math.floor(Date.now() / 1000) + COOKIE_DAYS * 86_400,
  });
}

chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
  if (!removed) void persistCookie(cookie).catch(() => undefined);
});

async function persistExistingCookies() {
  for (const cookie of await chrome.cookies.getAll({ url: OLAT_ORIGIN })) await persistCookie(cookie).catch(() => undefined);
}

// ---------------------------------------------------------------- Sitzung wachhalten

/** Fragt die Startseite an. Ist die Sitzung gültig, verlängert OLAT sie; sonst zeigt die Antwort das Login-Formular. */
async function keepAlive() {
  if (!(await store.getSettings()).keepAlive) return;
  if (!(await chrome.cookies.get({ url: `${OLAT_ORIGIN}/`, name: 'JSESSIONID' }))) {
    await setState({ lastPing: Date.now(), lastPingResult: 'noSession' });
    return;
  }
  try {
    const response = await fetch(`${OLAT_ORIGIN}/auth/`, { credentials: 'include', cache: 'no-store' });
    const html = await response.text();
    const loggedIn = response.ok && !html.includes('id="ofo_oolat_login"');
    await setState({ lastPing: Date.now(), lastPingResult: loggedIn ? 'ok' : 'loggedOut' });
  } catch {
    await setState({ lastPing: Date.now(), lastPingResult: 'error' });
  }
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get('keepalive'))) chrome.alarms.create('keepalive', { periodInMinutes: PING_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') void keepAlive();
});
chrome.runtime.onInstalled.addListener(() => void Promise.all([ensureAlarm(), persistExistingCookies()]));
chrome.runtime.onStartup.addListener(() => void Promise.all([ensureAlarm(), persistExistingCookies()]));
void ensureAlarm();

// ---------------------------------------------------------------- Nachrichten

/** Gibt die Zugangsdaten nur heraus, wenn alles passt, und höchstens dreimal pro 10 Minuten (Schutz vor Sperrung). */
async function credentialsForLogin() {
  if (!(await store.getSettings()).autoLogin) return { skip: 'disabled' };
  if ((await getState()).authError) return { skip: 'authError' };
  if (((await session.get('pausedUntil')) ?? 0) > Date.now()) return { skip: 'paused' };
  const creds = await store.getCredentials();
  if (!creds) return { skip: 'noCredentials' };
  const recent = ((await session.get('attempts')) ?? []).filter((t) => Date.now() - t < ATTEMPT_WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) return { skip: 'throttled' };
  await session.set('attempts', [...recent, Date.now()]);
  return creds;
}

async function status() {
  const creds = await store.getCredentials();
  return {
    hasCredentials: Boolean(creds),
    username: creds?.username ?? '',
    settings: await store.getSettings(),
    state: await getState(),
    pausedUntil: (await session.get('pausedUntil')) ?? 0,
  };
}

async function handle(message, sender) {
  // Content-Scripts melden die URL der Webseite als Absender, nur Seiten dieser Erweiterung haben die chrome-extension://-URL.
  const fromPopup = Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
  const fromOlat = Boolean(sender.tab && sender.url && new URL(sender.url).origin === OLAT_ORIGIN);

  if (fromOlat) {
    switch (message.type) {
      case 'getLoginCredentials':
        return credentialsForLogin();
      case 'loginFailed':
        await setState({ authError: { step: message.step, message: String(message.message ?? '').slice(0, 200), at: Date.now() } });
        return { ok: true };
      case 'userLoggedOut':
        await session.set('pausedUntil', Date.now() + LOGOUT_PAUSE_MS);
        return { ok: true };
    }
  }

  if (fromPopup) {
    switch (message.type) {
      case 'status':
        return status();
      case 'saveCredentials': {
        const username = String(message.username ?? '').trim();
        const password = String(message.password ?? '');
        if (!username || !password) return { error: 'Benutzername und Passwort sind erforderlich.' };
        await store.saveCredentials({ username, password });
        await session.set('attempts', []);
        await session.set('pausedUntil', 0);
        await setState({ authError: null });
        return status();
      }
      case 'clearCredentials':
        await store.clearCredentials();
        await setState({ authError: null });
        return status();
      case 'saveSettings': {
        const settings = await store.saveSettings(message.settings ?? {});
        if (settings.persistCookies) void persistExistingCookies();
        return status();
      }
      case 'resume':
        await session.set('attempts', []);
        await session.set('pausedUntil', 0);
        await setState({ authError: null });
        return status();
    }
  }
  return { error: 'Unbekannte Nachricht' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
  return true;
});

void getState().then(updateBadge);
