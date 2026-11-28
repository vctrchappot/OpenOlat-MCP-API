import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { OlatClientPool } from '../src/olat/pool.js';
import { StatelessTokenStore } from '../src/store/stateless.js';

describe('loadConfig store mode', () => {
  it('defaults to the file store and to stateless on Vercel', () => {
    expect(loadConfig({}).storeMode).toBe('file');
    expect(loadConfig({ VERCEL: '1' }).storeMode).toBe('stateless');
    expect(loadConfig({ VERCEL: '1', STORE: 'file' }).storeMode).toBe('file');
    expect(loadConfig({ STORE: 'stateless' }).storeMode).toBe('stateless');
  });
});

describe('HTTP app with the stateless store (Vercel)', () => {
  const store = new StatelessTokenStore('s'.repeat(40));
  const pool = new OlatClientPool({ baseUrl: 'https://olat.example.invalid', maxDownloadBytes: 1024, maxInlineBinaryBytes: 1024 });
  const app = createApp({ store, pool, baseUrl: 'https://olat.example.invalid', publicUrl: 'https://mcp.example.ch' });
  const { token } = store.create({ username: 'u', password: 'p' });
  const mcp = (headers: Record<string, string>, body: unknown) =>
    app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

  it('rejects /mcp without a valid token', async () => {
    expect((await mcp({}, {})).status).toBe(401);
    expect((await mcp({ authorization: 'Bearer olat_s1_garbage' }, {})).status).toBe(401);
  });

  it('lists only read-only tools for a valid token', async () => {
    const res = await mcp({ authorization: `Bearer ${token}` }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('olat_list_calendar_events');
    expect(names).toContain('olat_get_notifications');
    expect(result.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('explains that stateless tokens cannot be revoked', async () => {
    const res = await app.request('/api/tokens', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(501);
  });
});
