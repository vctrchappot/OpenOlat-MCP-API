import { OlatError } from './errors.js';

/** What an OLAT (or allow-listed landing page) URL points to. */
export type UrlTarget =
  | { kind: 'node'; courseId: number; nodeId: string; messageId?: string }
  | { kind: 'course'; courseId: number }
  | { kind: 'resource'; url: string }
  | { kind: 'webdav'; path: string }
  | { kind: 'landing'; url: string }
  | { kind: 'page'; path: string };

const REPOSITORY_ENTRY = /^\/(?:auth|url)\/RepositoryEntry\/(\d+)(?:\/CourseNode\/(\d+)(?:\/InfoMessage\/(\d+))?)?\/?$/;

/**
 * Works out what a URL refers to, without any network access. Accepts absolute OLAT URLs, OLAT business paths
 * ("/url/RepositoryEntry/123/CourseNode/456") and the embed URL of an allow-listed landing page. Everything else is
 * rejected: this tool never leaves OLAT (and the explicitly allowed landing page hosts).
 */
export function resolveUrl(input: string, base: URL, externalHosts: string[] = []): UrlTarget {
  const raw = input.trim();
  if (!raw) throw new OlatError('Keine URL angegeben.', 400);

  let url: URL;
  try {
    url = new URL(raw, raw.startsWith('/') ? base : undefined);
  } catch {
    throw new OlatError(`Ungültige URL: ${raw.slice(0, 80)}`, 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OlatError('Nur http(s)-URLs sind erlaubt.', 400);

  if (url.origin !== base.origin) {
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && externalHosts.map((h) => h.toLowerCase()).includes(host) && url.searchParams.get('id')) {
      return { kind: 'landing', url: url.href };
    }
    throw new OlatError(`Nur OLAT-URLs (${base.host}) und freigegebene Landing-Page-Hosts sind erlaubt, nicht ${host}.`, 400);
  }

  const entry = REPOSITORY_ENTRY.exec(url.pathname);
  if (entry) {
    const courseId = Number(entry[1]);
    return entry[2] ? { kind: 'node', courseId, nodeId: entry[2], ...(entry[3] ? { messageId: entry[3] } : {}) } : { kind: 'course', courseId };
  }
  if (url.pathname.startsWith('/m/')) return { kind: 'resource', url: url.href };
  if (url.pathname.startsWith('/webdav/')) return { kind: 'webdav', path: decodeURIComponent(url.pathname.replace(/^\/webdav\/?/, '')) };
  return { kind: 'page', path: `${url.pathname}${url.search}` };
}
