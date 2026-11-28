import { describe, expect, it, vi } from 'vitest';
import { fetchByUrl, type UrlClient } from '../src/olat/fetch-url.js';
import { resolveUrl } from '../src/olat/resolve.js';
import { renderFetch } from '../src/mcp/server.js';

const BASE = new URL('https://olat.bms-w.ch');
const HOSTS = ['landingpage.bmsw-server.ch'];

describe('resolveUrl', () => {
  it('recognises course nodes in all OLAT URL forms', () => {
    const node = { kind: 'node', courseId: 12648576, nodeId: '114484000378050' };
    expect(resolveUrl('https://olat.bms-w.ch/auth/RepositoryEntry/12648576/CourseNode/114484000378050', BASE)).toEqual(node);
    expect(resolveUrl('https://olat.bms-w.ch/url/RepositoryEntry/12648576/CourseNode/114484000378050/', BASE)).toEqual(node);
    expect(resolveUrl('/auth/RepositoryEntry/12648576/CourseNode/114484000378050', BASE)).toEqual(node);
    expect(resolveUrl('https://olat.bms-w.ch/url/RepositoryEntry/12648576/CourseNode/114484000378050/InfoMessage/107872277', BASE)).toEqual({
      ...node,
      messageId: '107872277',
    });
  });

  it('recognises courses, resources, WebDAV and generic pages', () => {
    expect(resolveUrl('https://olat.bms-w.ch/url/RepositoryEntry/98140222', BASE)).toEqual({ kind: 'course', courseId: 98140222 });
    expect(resolveUrl('https://olat.bms-w.ch/m/3e96d1fc/LandingPage.html', BASE)).toMatchObject({ kind: 'resource' });
    expect(resolveUrl('https://olat.bms-w.ch/webdav/home/Notizen%20neu/a.pdf', BASE)).toEqual({ kind: 'webdav', path: 'home/Notizen neu/a.pdf' });
    expect(resolveUrl('/url/HomeSite/42/effstatements/0', BASE)).toEqual({ kind: 'page', path: '/url/HomeSite/42/effstatements/0' });
    expect(resolveUrl('https://olat.bms-w.ch/url/RepositoryEntry/98140222/Infos/0', BASE)).toMatchObject({ kind: 'page' });
  });

  it('accepts only OLAT and allow-listed landing page hosts', () => {
    expect(resolveUrl('https://landingpage.bmsw-server.ch/bmsw_lp-v20.html?id=lp-abc123/LT26l_Deutsch', BASE, HOSTS)).toMatchObject({ kind: 'landing' });
    expect(() => resolveUrl('https://landingpage.bmsw-server.ch/x.html', BASE, HOSTS)).toThrow(/erlaubt/);
    expect(() => resolveUrl('https://landingpage.bmsw-server.ch/x.html?id=lp-abc123', BASE, [])).toThrow(/erlaubt/);
    expect(() => resolveUrl('https://evil.example/auth/RepositoryEntry/1/CourseNode/2', BASE, HOSTS)).toThrow(/erlaubt/);
    expect(() => resolveUrl('file:///etc/passwd', BASE)).toThrow();
    expect(() => resolveUrl('javascript:alert(1)', BASE)).toThrow();
    expect(() => resolveUrl('   ', BASE)).toThrow(/Keine URL/);
  });
});

const node = (over: Record<string, unknown> = {}) => ({
  courseId: 1,
  nodeId: '2',
  title: 'Baustein',
  type: 'page',
  url: 'https://olat.bms-w.ch/url/RepositoryEntry/1/CourseNode/2',
  opened: true,
  markdown: 'Inhalt',
  links: [],
  files: [],
  downloadable: false,
  children: [],
  ...over,
});

function stubClient(nodeView: ReturnType<typeof node>, landing: unknown = null) {
  const client = {
    baseUrl: BASE,
    allowedExternalHosts: HOSTS,
    getCourseInfo: vi.fn(async () => ({ id: 1, title: 'Klassen-Portal', folders: [] })),
    getCourseTree: vi.fn(async () => []),
    getCourseNode: vi.fn(async () => nodeView),
    listFolder: vi.fn(async () => ({ path: 'A', total: 0, truncated: false, entries: [] })),
    readFile: vi.fn(async () => ({ file: { filename: 'a.pdf' }, content: { kind: 'text', text: 'x' } })),
    fetchResource: vi.fn(async () => ({ file: { filename: 'r.html' }, content: { kind: 'text', text: 'r' } })),
    readWebDavFile: vi.fn(),
    openPage: vi.fn(async () => ({ title: 'Seite', url: 'u', markdown: 'm', files: [] })),
    listCalendars: vi.fn(async () => [{ id: 'course_9', displayName: 'Klassen-Portal' }]),
    listEvents: vi.fn(async () => []),
    landingFromCandidates: vi.fn(async () => landing),
  };
  return client as typeof client & UrlClient;
}

const URL_NODE = 'https://olat.bms-w.ch/auth/RepositoryEntry/1/CourseNode/2';

describe('fetchByUrl picks the action', () => {
  const messages = '## Mitteilungen\n\n2026\n\nNOV\n\n26\n\n### Hausaufgaben\n\nPubliziert von X am 26.11.2026, 15:09\n\nAufgabe 5\n';

  it('info-messages node → messages (with since filter)', async () => {
    const c = stubClient(node({ type: 'info-messages', markdown: messages }));
    const r = await fetchByUrl(c, URL_NODE);
    expect(r).toMatchObject({ action: 'info_messages', messages: [{ title: 'Hausaufgaben', text: 'Aufgabe 5' }] });
    const later = await fetchByUrl(c, URL_NODE, { since: '2026-12-01' });
    expect(later).toMatchObject({ action: 'info_messages', messages: [] });
  });

  it('node with an allowed landing page embed → lesson plan', async () => {
    const page = { lessons: [{ date: '2026-12-03' }], from: '2026-11-28' };
    const c = stubClient(node({ type: 'external-page' }), page);
    expect(await fetchByUrl(c, URL_NODE, { from: '2026-11-28' })).toEqual({ action: 'landing_page', page });
    expect(c.landingFromCandidates).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ from: '2026-11-28' }));
  });

  it('landing page URL itself → lesson plan without opening OLAT', async () => {
    const page = { lessons: [], from: '2026-11-28' };
    const c = stubClient(node(), page);
    const r = await fetchByUrl(c, 'https://landingpage.bmsw-server.ch/bmsw_lp-v20.html?id=lp-abc123/LT26l_Deutsch');
    expect(r.action).toBe('landing_page');
    expect(c.getCourseNode).not.toHaveBeenCalled();
  });

  it('folder node → listing; with path → subfolder or file', async () => {
    const folder = { path: '', total: 1, truncated: false, entries: [{ kind: 'file', name: 'a.pdf' }] };
    const c = stubClient(node({ type: 'folder', folder }));
    expect(await fetchByUrl(c, URL_NODE)).toMatchObject({ action: 'folder', folder });
    expect(await fetchByUrl(c, URL_NODE, { path: 'Kapitel 1' })).toMatchObject({ action: 'folder' });
    expect(c.listFolder).toHaveBeenCalledWith(1, '2', 'Kapitel 1');
    expect(await fetchByUrl(c, URL_NODE, { path: 'Kapitel 1/a.pdf' })).toMatchObject({ action: 'file' });
    expect(c.readFile).toHaveBeenCalledWith(1, '2', 'Kapitel 1/a.pdf', 0);
  });

  it('document node → file text; page with files → page unless fileIndex is given', async () => {
    const doc = stubClient(node({ type: 'document', downloadable: true }));
    expect(await fetchByUrl(doc, URL_NODE)).toMatchObject({ action: 'file' });

    const withFiles = stubClient(node({ files: [{ name: 'a.pdf', url: 'u' }] }));
    expect((await fetchByUrl(withFiles, URL_NODE)).action).toBe('node');
    expect((await fetchByUrl(withFiles, URL_NODE, { fileIndex: 0 })).action).toBe('file');
    expect(withFiles.readFile).toHaveBeenCalledWith(1, '2', undefined, 0);
  });

  it('calendar node → events of that course calendar', async () => {
    const c = stubClient(node({ type: 'calendar' }));
    expect((await fetchByUrl(c, URL_NODE, { from: '2026-12-01' })).action).toBe('calendar');
    expect(c.listEvents).toHaveBeenCalledWith(expect.any(Date), undefined, 'course_9');
  });

  it('course, resource and page URLs', async () => {
    const c = stubClient(node());
    expect((await fetchByUrl(c, 'https://olat.bms-w.ch/url/RepositoryEntry/1')).action).toBe('course');
    expect((await fetchByUrl(c, 'https://olat.bms-w.ch/m/abc/x.html')).action).toBe('file');
    expect((await fetchByUrl(c, '/url/HomeSite/42/effstatements/0')).action).toBe('page');
  });

  it('refuses nodes the user cannot open and foreign URLs', async () => {
    await expect(fetchByUrl(stubClient(node({ opened: false })), URL_NODE)).rejects.toThrow(/nicht zugänglich/);
    await expect(fetchByUrl(stubClient(node()), 'https://example.com/x')).rejects.toThrow(/erlaubt/);
  });
});

describe('renderFetch', () => {
  it('names the action in the first line', () => {
    const out = renderFetch({ action: 'info_messages', title: 'T', url: 'u', messages: [] });
    expect((out.content[0] as { text: string }).text.split('\n')[0]).toBe('Aktion: info_messages – 0 Mitteilung(en), neueste zuerst');
    const file = renderFetch({ action: 'file', file: { file: { filename: 'a.txt', contentType: 'text/plain', size: 1 }, content: { kind: 'text', text: 'hi' } } as never });
    expect((file.content[0] as { text: string }).text).toBe('Aktion: file');
  });
});
