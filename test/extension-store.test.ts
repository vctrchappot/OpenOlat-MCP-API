import { describe, expect, it } from 'vitest';
import { createStore, DEFAULT_SETTINGS, memoryKeyVault } from '../extension/store.js';

function memoryStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => void data.set(key, value),
    remove: async (key: string) => void data.delete(key),
  };
}

describe('extension credential store', () => {
  it('round-trips credentials and never keeps them in plain text', async () => {
    const storage = memoryStorage();
    const store = createStore({ storage, vault: memoryKeyVault() });
    await store.saveCredentials({ username: 'max.muster', password: 'Geheim-123!' });

    expect(JSON.stringify([...storage.data])).not.toContain('Geheim-123!');
    expect(JSON.stringify([...storage.data])).not.toContain('max.muster');
    expect(await store.getCredentials()).toEqual({ username: 'max.muster', password: 'Geheim-123!' });
  });

  it('cannot decrypt without the original key (e.g. copied profile files)', async () => {
    const storage = memoryStorage();
    await createStore({ storage, vault: memoryKeyVault() }).saveCredentials({ username: 'u', password: 'p' });
    expect(await createStore({ storage, vault: memoryKeyVault() }).getCredentials()).toBeNull();
  });

  it('returns null for missing or tampered data', async () => {
    const storage = memoryStorage();
    const store = createStore({ storage, vault: memoryKeyVault() });
    expect(await store.getCredentials()).toBeNull();

    await store.saveCredentials({ username: 'u', password: 'p' });
    const entry = storage.data.get('credentials') as { ct: string };
    storage.data.set('credentials', { ...entry, ct: entry.ct.slice(0, -4) + 'AAAA' });
    expect(await store.getCredentials()).toBeNull();
  });

  it('clears credentials', async () => {
    const store = createStore({ storage: memoryStorage(), vault: memoryKeyVault() });
    await store.saveCredentials({ username: 'u', password: 'p' });
    await store.clearCredentials();
    expect(await store.getCredentials()).toBeNull();
  });

  it('merges settings with defaults and ignores unknown or non-boolean values', async () => {
    const store = createStore({ storage: memoryStorage(), vault: memoryKeyVault() });
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
    const next = await store.saveSettings({ keepAlive: false, autoLogin: 'yes', evil: true });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, keepAlive: false });
    expect(await store.getSettings()).toEqual({ ...DEFAULT_SETTINGS, keepAlive: false });
  });
});
