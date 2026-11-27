import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context } from 'hono';
import { createMcpServer } from '../mcp/server.js';
import type { OlatClient } from '../olat/client.js';
import { OlatAuthError, OlatError } from '../olat/errors.js';
import type { OlatClientPool } from '../olat/pool.js';
import { OlatRestClient } from '../olat/rest.js';
import type { Credentials } from '../olat/web.js';
import type { CredentialStore, TokenInfo } from '../store/credentials.js';
import { registerPage } from './page.js';

export interface AppDeps {
  store: CredentialStore;
  pool: OlatClientPool;
  baseUrl: string;
  /** Public URL of this server (for the setup page). */
  publicUrl?: string;
}

type Env = { Variables: { client: OlatClient; token: string; tokenInfo: TokenInfo } };

/** Simple fixed-window rate limiter for the registration endpoint. */
function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; at: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.at > windowMs) {
      hits.set(key, { n: 1, at: now });
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}

function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function errorResponse(c: Context, e: unknown) {
  if (e instanceof OlatError) return c.json({ error: e.name, message: e.message }, (e.status ?? 502) as any);
  console.error(e);
  return c.json({ error: 'InternalError', message: (e as Error).message }, 500);
}

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>();
  const allowRegister = rateLimiter(10, 10 * 60_000);
  const base = new URL(deps.baseUrl);

  app.onError((e, c) => errorResponse(c, e));

  app.get('/', (c) => c.html(registerPage(deps.publicUrl ?? new URL(c.req.url).origin, base.host)));
  app.get('/health', (c) => c.json({ ok: true }));

  // ------------------------------------------------------------------ credentials
  app.post('/api/tokens', async (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'local';
    if (!allowRegister(ip)) return c.json({ error: 'RateLimited', message: 'Zu viele Versuche, bitte später erneut.' }, 429);
    let body: { username?: string; password?: string; label?: string };
    const type = c.req.header('content-type') ?? '';
    if (type.includes('application/json')) body = await c.req.json();
    else body = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    const username = body.username?.trim();
    const password = body.password ?? '';
    if (!username || !password) return c.json({ error: 'BadRequest', message: 'username und password sind erforderlich.' }, 400);
    const creds: Credentials = { username, password };
    try {
      const me = await new OlatRestClient(base, creds).get<{ key: number; firstName: string; lastName: string }>('users/me');
      const { token, info } = deps.store.create(creds, body.label);
      return c.json({ token, info, user: { key: me.key, name: `${me.firstName} ${me.lastName}` } }, 201);
    } catch (e) {
      if (e instanceof OlatAuthError) return c.json({ error: 'InvalidCredentials', message: 'OpenOLAT hat Benutzername oder Passwort abgelehnt.' }, 401);
      throw e;
    }
  });

  // Everything below requires a token.
  const auth = async (c: Context<Env>, next: () => Promise<void>) => {
    const token = bearer(c);
    const hit = token ? deps.store.resolve(token) : null;
    if (!token || !hit) {
      c.header('WWW-Authenticate', 'Bearer realm="openolat-mcp-api"');
      return c.json({ error: 'Unauthorized', message: 'Gültiges Token im Header "Authorization: Bearer <token>" erforderlich.' }, 401);
    }
    c.set('client', deps.pool.get(hit.creds));
    c.set('token', token);
    c.set('tokenInfo', hit.info);
    await next();
  };

  app.get('/api/tokens', auth, (c) => c.json(deps.store.listForToken(c.get('token'))));
  app.delete('/api/tokens', auth, (c) => {
    const resolved = deps.store.resolve(c.get('token'));
    const n = deps.store.revoke(c.get('token'), c.req.query('all') === 'true');
    if (resolved) deps.pool.drop(resolved.creds);
    return c.json({ revoked: n });
  });

  // ------------------------------------------------------------------ read-only REST API
  const api = new Hono<Env>();
  api.use('*', auth);
  api.get('/me', async (c) => c.json(await c.get('client').whoami()));
  api.get('/courses', async (c) => {
    const client = c.get('client');
    return c.json(c.req.query('scope') === 'favorites' ? await client.listFavoriteCourses() : await client.listMyCourses());
  });
  api.get('/courses/search', async (c) => c.json(await c.get('client').searchCourses(c.req.query('q') ?? '', Number(c.req.query('limit') ?? 25))));
  api.get('/courses/:id{[0-9]+}', async (c) => c.json(await c.get('client').getCourseInfo(Number(c.req.param('id')))));
  api.get('/courses/:id{[0-9]+}/tree', async (c) => c.json(await c.get('client').getCourseTree(Number(c.req.param('id')), { refresh: c.req.query('refresh') === 'true' })));
  api.get('/courses/:id{[0-9]+}/nodes/:node{[0-9]+}', async (c) => c.json(await c.get('client').getCourseNode(Number(c.req.param('id')), c.req.param('node'))));
  api.get('/courses/:id{[0-9]+}/nodes/:node{[0-9]+}/folder', async (c) => c.json(await c.get('client').listFolder(Number(c.req.param('id')), c.req.param('node'), c.req.query('path'))));
  api.get('/courses/:id{[0-9]+}/nodes/:node{[0-9]+}/file', async (c) => {
    const r = await c.get('client').readFile(Number(c.req.param('id')), c.req.param('node'), c.req.query('path'), Number(c.req.query('index') ?? 0));
    return fileResponse(c, r);
  });
  api.get('/resource', async (c) => fileResponse(c, await c.get('client').fetchResource(c.req.query('url') ?? '')));
  api.get('/page', async (c) => c.json(await c.get('client').openPage(c.req.query('path') ?? '')));
  api.get('/groups', async (c) => c.json(await c.get('client').listGroups()));
  api.get('/calendars', async (c) => c.json(await c.get('client').listCalendars()));
  api.get('/calendar/events', async (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    return c.json(await c.get('client').listEvents(from ? new Date(from) : undefined, to ? new Date(to) : undefined, c.req.query('calendarId')));
  });
  api.get('/notifications', async (c) => {
    const since = c.req.query('since');
    return c.json(await c.get('client').notifications(since ? new Date(since) : new Date(Date.now() - 7 * 86_400_000)));
  });
  api.get('/webdav', async (c) => c.json(await c.get('client').listWebDav(c.req.query('path') ?? '')));
  api.get('/webdav/file', async (c) => fileResponse(c, await c.get('client').readWebDavFile(c.req.query('path') ?? '')));
  app.route('/api', api);

  // ------------------------------------------------------------------ MCP (Streamable HTTP, stateless)
  app.all('/mcp', auth, async (c) => {
    const client = c.get('client');
    const server = createMcpServer(() => client);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });

  return app;
}

function fileResponse(c: Context, r: import('../olat/client.js').ReadFileResult) {
  if (c.req.query('format') === 'json') {
    const { raw: _raw, ...rest } = r;
    return c.json(rest);
  }
  const ascii = r.file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return new Response(new Uint8Array(r.raw), {
    headers: {
      'content-type': r.file.contentType,
      'content-disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.file.filename)}`,
      ...(r.file.truncated ? { 'x-olat-truncated': 'true' } : {}),
    },
  });
}
