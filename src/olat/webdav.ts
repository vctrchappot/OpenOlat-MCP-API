import { createHash, randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio';
import { OlatAuthError, OlatError, NotFoundError, ReadOnlyViolation } from './errors.js';
import type { Credentials } from './web.js';

export interface DavEntry {
  path: string;
  name: string;
  isFolder: boolean;
  size?: number;
  contentType?: string;
  modified?: string;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Read-only WebDAV client (`/webdav`) with HTTP Digest authentication. Only PROPFIND and GET. */
export class OlatWebDavClient {
  private challenge: Record<string, string> | null = null;
  private nc = 0;

  constructor(
    private readonly base: URL,
    private readonly creds: Credentials,
  ) {}

  static normalize(path: string): string {
    const parts = path
      .split('/')
      .filter((p) => p && p !== '.')
      .map((p) => {
        if (p === '..') throw new ReadOnlyViolation('Pfad mit ".." ist nicht erlaubt');
        return p;
      });
    if (parts[0] === 'webdav') parts.shift();
    return parts.join('/');
  }

  private url(path: string, folder: boolean): URL {
    const norm = OlatWebDavClient.normalize(path);
    const enc = norm
      .split('/')
      .filter(Boolean)
      .map((p) => encodeURIComponent(decodeURIComponentSafe(p)))
      .join('/');
    return new URL(`/webdav/${enc}${enc && folder ? '/' : ''}`, this.base);
  }

  private digestHeader(method: 'GET' | 'PROPFIND', url: URL): string | undefined {
    const c = this.challenge;
    if (!c) return undefined;
    const uri = url.pathname + url.search;
    const ha1 = md5(`${this.creds.username}:${c.realm}:${this.creds.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const nc = (++this.nc).toString(16).padStart(8, '0');
    const cnonce = randomBytes(8).toString('hex');
    const qop = c.qop?.split(',')[0].trim();
    const response = qop ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`);
    const parts = [`username="${this.creds.username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `response="${response}"`, 'algorithm=MD5'];
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    if (c.opaque) parts.push(`opaque="${c.opaque}"`);
    return `Digest ${parts.join(', ')}`;
  }

  private async request(method: 'GET' | 'PROPFIND', url: URL, headers: Record<string, string> = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = this.digestHeader(method, url);
      const res = await fetch(url, {
        method,
        headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status !== 401) return res;
      const www = res.headers.get('www-authenticate') ?? '';
      if (!/^Digest/i.test(www)) throw new OlatAuthError();
      const fresh: Record<string, string> = {};
      for (const m of www.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) fresh[m[1]] = m[2] ?? m[3];
      const stale = /stale=true/i.test(www);
      if (attempt === 1 && !stale) throw new OlatAuthError();
      this.challenge = fresh;
      this.nc = 0;
      await res.body?.cancel();
    }
    throw new OlatAuthError();
  }

  async list(path = ''): Promise<DavEntry[]> {
    const url = this.url(path, true);
    const res = await this.request('PROPFIND', url, { depth: '1', 'content-type': 'application/xml' });
    if (res.status === 404) throw new NotFoundError(`WebDAV-Pfad nicht gefunden: ${path}`);
    if (res.status !== 207) throw new OlatError(`WebDAV PROPFIND → HTTP ${res.status}`, res.status);
    const $ = cheerio.load(await res.text(), { xml: true });
    const self = url.pathname.replace(/\/$/, '');
    const entries: DavEntry[] = [];
    $('D\\:response, response').each((_, r) => {
      const el = $(r);
      const href = decodeURIComponentSafe(el.find('D\\:href, href').first().text());
      if (href.replace(/\/$/, '') === decodeURIComponentSafe(self)) return;
      const isFolder = el.find('D\\:collection, collection').length > 0;
      const rel = href.replace(/^\/webdav\/?/, '').replace(/\/$/, '');
      const size = Number(el.find('D\\:getcontentlength, getcontentlength').first().text());
      entries.push({
        path: rel,
        name: rel.split('/').pop() ?? rel,
        isFolder,
        size: Number.isFinite(size) && !isFolder ? size : undefined,
        contentType: el.find('D\\:getcontenttype, getcontenttype').first().text() || undefined,
        modified: el.find('D\\:getlastmodified, getlastmodified').first().text() || undefined,
      });
    });
    return entries;
  }

  async download(path: string, maxBytes: number): Promise<{ contentType: string; data: Buffer; truncated: boolean; filename: string }> {
    const url = this.url(path, false);
    const res = await this.request('GET', url);
    if (res.status === 404) throw new NotFoundError(`Datei nicht gefunden: ${path}`);
    if (!res.ok) throw new OlatError(`WebDAV GET → HTTP ${res.status}`, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      data: buf.subarray(0, maxBytes),
      truncated: buf.length > maxBytes,
      filename: OlatWebDavClient.normalize(path).split('/').pop() ?? 'datei',
    };
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
