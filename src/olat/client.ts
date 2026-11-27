import * as cheerio from 'cheerio';
import { commandHtml, commandRedirect } from './commands.js';
import { extractContent, type ExtractedContent, type FileData } from './content.js';
import { NotFoundError, OlatError } from './errors.js';
import { htmlToMarkdown, type LinkRef } from './markdown.js';
import { parseCourseTree, parseFolder, parseNodeContent, type FileRef, type FolderEntry, type TreeNode } from './parse.js';
import { OlatRestClient, type RestCalendar, type RestCourse, type RestEvent, type RestGroup, type RestNotification, type RestUser } from './rest.js';
import { OlatWebDavClient, type DavEntry } from './webdav.js';
import { OlatWebSession, type Credentials } from './web.js';

export interface OlatClientOptions {
  baseUrl: string;
  /** Max. bytes per downloaded file. */
  maxDownloadBytes?: number;
  /** Max. bytes of binary content returned inline (base64). */
  maxInlineBinaryBytes?: number;
}

export interface CourseSummary {
  /** Repository entry id – the id used in OpenOLAT URLs (`/RepositoryEntry/{id}`). */
  id: number;
  courseKey: number;
  title: string;
  description: string;
  status: string;
  type: 'learningpath' | 'condition' | string;
  url: string;
}

export interface CourseTreeNode {
  id: string;
  title: string;
  type: string;
  status?: string;
  children: CourseTreeNode[];
}

export interface CourseNodeView {
  courseId: number;
  nodeId: string;
  title: string;
  type: string;
  url: string;
  /** False if OpenOLAT showed a different node (e.g. no access). */
  opened: boolean;
  markdown: string;
  links: LinkRef[];
  /** Files shown in the node (single pages, viewers, media). Read with `readFile(courseId, nodeId)`. */
  files: FileRef[];
  /** The node offers a "download" button (document nodes) – read it with `readFile(courseId, nodeId)`. */
  downloadable: boolean;
  children: { id: string; title: string; type: string }[];
  folder?: FolderView;
}

export interface FolderView {
  path: string;
  total?: number;
  truncated: boolean;
  entries: Omit<FolderEntry, 'download'>[];
}

export interface ReadFileResult {
  file: Omit<FileData, 'data'> & { size: number };
  content: ExtractedContent;
  raw: Buffer;
}

const TREE_TTL = 10 * 60_000;
const CATALOG_TTL = 15 * 60_000;

function stripHtml(s: string | null | undefined): string {
  if (!s) return '';
  return cheerio.load(s).text().replace(/\s+/g, ' ').trim();
}

/** Normalizes a folder path inside a folder node: "a/b/" → "a/b". */
export function normalizeFolderPath(path: string | undefined): string {
  return (path ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.')
    .map((p) => {
      if (p === '..') throw new OlatError('".." ist in Pfaden nicht erlaubt');
      return p;
    })
    .join('/');
}

/** Business path segment that opens a folder (or file) inside a folder node. */
export function folderPathSegment(path: string): string {
  const norm = normalizeFolderPath(path);
  if (!norm) return '';
  return `/path%3D${encodeURIComponent('~~' + norm.split('/').join('~~'))}/0`;
}

export function toAuthPath(pathOrUrl: string, base: URL): string {
  const u = new URL(pathOrUrl.startsWith('/') || /^https?:/i.test(pathOrUrl) ? pathOrUrl : `/auth/${pathOrUrl}`, base);
  if (u.origin !== base.origin) throw new OlatError(`Nur Seiten von ${base.origin} können geöffnet werden.`);
  return u.pathname.replace(/^\/url\//, '/auth/') + u.search;
}

/** High-level, read-only access to everything a user can see on OpenOLAT. */
export class OlatClient {
  readonly base: URL;
  readonly rest: OlatRestClient;
  readonly web: OlatWebSession;
  readonly dav: OlatWebDavClient;
  private readonly maxDownload: number;
  private readonly maxInline: number;
  private me?: RestUser;
  private trees = new Map<number, { at: number; nodes: TreeNode[] }>();
  private catalog?: { at: number; courses: RestCourse[] };

  constructor(
    readonly creds: Credentials,
    opts: OlatClientOptions,
  ) {
    this.base = new URL(opts.baseUrl);
    this.rest = new OlatRestClient(this.base, creds);
    this.web = new OlatWebSession(this.base, creds);
    this.dav = new OlatWebDavClient(this.base, creds);
    this.maxDownload = opts.maxDownloadBytes ?? 30 * 1024 * 1024;
    this.maxInline = opts.maxInlineBinaryBytes ?? 4 * 1024 * 1024;
  }

  // ---------------------------------------------------------------- user & courses (REST)

  async whoami(): Promise<RestUser> {
    if (!this.me) {
      const u = await this.rest.get<RestUser>('users/me');
      this.me = { key: u.key, firstName: u.firstName, lastName: u.lastName, email: u.email };
    }
    return this.me;
  }

  private toSummary(c: RestCourse): CourseSummary {
    return {
      id: c.repoEntryKey,
      courseKey: c.key,
      title: c.displayName || c.title,
      description: stripHtml(c.description),
      status: c.repoEntryStatus,
      type: c.nodeAccessType ?? '',
      url: new URL(`/url/RepositoryEntry/${c.repoEntryKey}`, this.base).href,
    };
  }

  async listMyCourses(): Promise<CourseSummary[]> {
    const me = await this.whoami();
    const courses = await this.rest.get<RestCourse[]>(`users/${me.key}/courses/my`);
    return courses.map((c) => this.toSummary(c));
  }

  async listFavoriteCourses(): Promise<CourseSummary[]> {
    const me = await this.whoami();
    const courses = await this.rest.get<RestCourse[]>(`users/${me.key}/courses/favorite`);
    return courses.map((c) => this.toSummary(c));
  }

  /** Searches all courses visible to the user (own courses and courses published to all users). */
  async searchCourses(query: string, limit = 25): Promise<CourseSummary[]> {
    if (!this.catalog || Date.now() - this.catalog.at > CATALOG_TTL) {
      this.catalog = { at: Date.now(), courses: await this.rest.get<RestCourse[]>('repo/courses') };
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.catalog.courses
      .filter((c) => {
        const hay = `${c.displayName} ${c.title} ${c.externalRef ?? ''} ${stripHtml(c.description)} ${c.authors ?? ''}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, limit)
      .map((c) => this.toSummary(c));
  }

  async getCourseInfo(courseId: number): Promise<CourseSummary & { folders: { nodeId: string; title: string }[] }> {
    const entry = await this.rest.get<{ olatResourceId: number; displayname: string; description: string; entryStatus: string }>(`repo/entries/${courseId}`);
    const course = await this.rest.get<RestCourse>(`repo/courses/${entry.olatResourceId}`);
    let folders: { nodeId: string; title: string }[] = [];
    try {
      const res = await this.rest.get<{ folders: { courseNodeId: string; detailsName: string }[] }>(`repo/courses/${entry.olatResourceId}/elements/folder`);
      folders = res.folders.map((f) => ({ nodeId: f.courseNodeId, title: f.detailsName }));
    } catch {
      /* optional */
    }
    return { ...this.toSummary(course), folders };
  }

  async listGroups(): Promise<RestGroup[]> {
    const me = await this.whoami();
    return this.rest.get<RestGroup[]>(`users/${me.key}/groups`);
  }

  async listCalendars(): Promise<RestCalendar[]> {
    const me = await this.whoami();
    return this.rest.get<RestCalendar[]>(`users/${me.key}/calendars`);
  }

  async listEvents(from?: Date, to?: Date, calendarId?: string): Promise<(RestEvent & { calendar?: string })[]> {
    const me = await this.whoami();
    const [calendars, events] = await Promise.all([
      this.listCalendars(),
      this.rest.get<RestEvent[]>(calendarId ? `users/${me.key}/calendars/${encodeURIComponent(calendarId)}/events` : `users/${me.key}/calendars/events`),
    ]);
    const names = new Map(calendars.map((c) => [c.id, c.displayName]));
    return events
      .filter((e) => (!from || e.end >= from.getTime()) && (!to || e.begin <= to.getTime()))
      .sort((a, b) => a.begin - b.begin)
      .map((e) => ({ ...e, description: stripHtml(e.description?.replace(/\n/g, '<br>')), calendar: names.get(e.calendarId) }));
  }

  /** News from subscriptions (info messages, forum posts, new files, …) since `since`. */
  async notifications(since: Date): Promise<RestNotification[]> {
    return this.rest.get<RestNotification[]>('notifications', { date: since.toISOString().slice(0, 19) });
  }

  // ---------------------------------------------------------------- course structure (web UI)

  /**
   * Returns the full course menu. Collapsed nodes are expanded via the tree's expand event,
   * which does not open (and so does not mark as visited) the nodes themselves.
   */
  async getCourseTree(courseId: number, opts: { refresh?: boolean } = {}): Promise<CourseTreeNode[]> {
    const cached = this.trees.get(courseId);
    const nodes = !opts.refresh && cached && Date.now() - cached.at < TREE_TTL ? cached.nodes : await this.loadTree(courseId);
    const byParent = new Map<string | null, TreeNode[]>();
    for (const n of nodes) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n]);
    const build = (parent: string | null): CourseTreeNode[] =>
      (byParent.get(parent) ?? []).map((n) => ({ id: n.id, title: n.title, type: n.type, status: n.status, children: build(n.id) }));
    return build(null);
  }

  private loadTree(courseId: number): Promise<TreeNode[]> {
    return this.web.exclusive(async () => {
      const page = await this.web.pageUnlocked(`/auth/RepositoryEntry/${courseId}`);
      let current = parseCourseTree(page.html);
      if (!current.length) throw new NotFoundError(`Kurs ${courseId} nicht gefunden oder kein Zugriff.`);
      const nodes = new Map(current.map((n) => [n.id, n]));
      const tried = new Set<string>();
      for (let i = 0; i < 500; i++) {
        const next = current.find((n) => n.hasChildren && !n.expanded && n.expand && !tried.has(n.id));
        if (!next) break;
        tried.add(next.id);
        const res = await this.web.eventUnlocked(next.expand!, page.html);
        const parsed = parseCourseTree(commandHtml(res));
        if (parsed.length) current = parsed;
        for (const n of parsed) {
          const prev = nodes.get(n.id);
          nodes.set(n.id, { ...n, expanded: n.expanded || !!prev?.expanded });
        }
      }
      const all = [...nodes.values()];
      this.trees.set(courseId, { at: Date.now(), nodes: all });
      return all;
    });
  }

  /** Opens a course node and returns its content as Markdown (single pages are inlined). */
  async getCourseNode(courseId: number, nodeId: string): Promise<CourseNodeView> {
    return this.web.exclusive(async () => {
      const page = await this.web.pageUnlocked(`/auth/RepositoryEntry/${courseId}/CourseNode/${nodeId}`);
      const tree = parseCourseTree(page.html);
      if (!tree.length) throw new NotFoundError(`Kurs ${courseId} nicht gefunden oder kein Zugriff.`);
      const $ = cheerio.load(page.html);
      const active = $('.o_course_menu li[aria-selected="true"]').attr('data-nodeid') ?? $('.o_course_menu li.active').attr('data-nodeid');
      const self = tree.find((n) => n.id === nodeId);
      const content = parseNodeContent(page.html, page.url);

      // Inline embedded HTML pages (single page nodes) and keep other embeds as files.
      let markdown = content.markdown;
      const files: FileRef[] = [];
      for (const embed of content.embeds) {
        if (/\.html?(\?|$)/i.test(new URL(embed.url).pathname)) {
          try {
            const dl = await this.web.downloadUnlocked(embed.url, 5 * 1024 * 1024);
            if (dl.contentType.includes('html')) {
              const inner = htmlToMarkdown(dl.data.toString('utf8'), dl.url);
              markdown = `${markdown}\n\n${inner.markdown}`.trim();
              content.links.push(...inner.links);
              continue;
            }
          } catch {
            /* keep as file */
          }
        }
        files.push(embed);
      }

      let folder: FolderView | undefined;
      if (content.isFolder) {
        const listing = parseFolder(page.html);
        folder = { path: '', total: listing.total, truncated: listing.truncated, entries: listing.entries.map(({ download: _d, ...e }) => e) };
        markdown = markdown.replace(/\n*\|[\s\S]*\|\n*/m, '\n'); // table is returned structured
      }

      return {
        courseId,
        nodeId,
        title: self?.title ?? content.title,
        type: self?.type ?? '',
        url: new URL(`/url/RepositoryEntry/${courseId}/CourseNode/${nodeId}`, this.base).href,
        opened: !active || active === nodeId,
        markdown,
        links: dedupeLinks(content.links),
        files,
        downloadable: !!content.download,
        children: tree.filter((n) => n.parentId === nodeId).map((n) => ({ id: n.id, title: n.title, type: n.type })),
        folder,
      };
    });
  }

  /** Lists a (sub)folder of a folder course node. */
  async listFolder(courseId: number, nodeId: string, path?: string): Promise<FolderView> {
    const norm = normalizeFolderPath(path);
    return this.web.exclusive(async () => {
      const page = await this.web.pageUnlocked(`/auth/RepositoryEntry/${courseId}/CourseNode/${nodeId}${folderPathSegment(norm)}`);
      const listing = parseFolder(page.html);
      if (!listing.entries.length && !page.html.includes('o_folder_row') && !/0 Einträge/.test(page.html)) {
        if (!parseNodeContent(page.html, page.url).isFolder) throw new NotFoundError(`Knoten ${nodeId} ist kein Ordner oder nicht zugänglich.`);
      }
      return { path: norm, total: listing.total, truncated: listing.truncated, entries: listing.entries.map(({ download: _d, ...e }) => e) };
    });
  }

  /**
   * Reads a file. With `path`, the file is taken from the folder node (any file type; folders
   * are zipped by OpenOLAT). Without `path`, the primary file displayed by the node is used
   * (e.g. the PDF of a single page node), or `fileIndex` to pick another embedded file.
   */
  async readFile(courseId: number, nodeId: string, path?: string, fileIndex = 0): Promise<ReadFileResult> {
    const norm = normalizeFolderPath(path);
    const file = await this.web.exclusive(async (): Promise<FileData> => {
      if (norm) {
        const parts = norm.split('/');
        const name = parts.pop()!;
        const page = await this.web.pageUnlocked(`/auth/RepositoryEntry/${courseId}/CourseNode/${nodeId}${folderPathSegment(parts.join('/'))}`);
        const entry = parseFolder(page.html).entries.find((e) => e.name === name);
        if (!entry) throw new NotFoundError(`"${norm}" wurde im Ordner nicht gefunden.`);
        if (!entry.download) throw new OlatError(`"${norm}" kann nicht heruntergeladen werden.`);
        const res = await this.web.eventUnlocked(entry.download, page.html);
        const target = commandRedirect(res);
        if (!target) throw new OlatError('OpenOLAT hat keinen Download-Link geliefert.');
        const dl = await this.web.downloadUnlocked(target, this.maxDownload);
        return { filename: dl.filename ?? (entry.kind === 'folder' ? `${name}.zip` : name), contentType: dl.contentType, data: dl.data, truncated: dl.truncated, source: `${courseId}/${nodeId}/${norm}` };
      }
      const page = await this.web.pageUnlocked(`/auth/RepositoryEntry/${courseId}/CourseNode/${nodeId}`);
      const parsed = parseNodeContent(page.html, page.url);
      const embed = parsed.embeds[fileIndex];
      if (!embed && fileIndex === 0 && parsed.download) {
        const res = await this.web.eventUnlocked(parsed.download, page.html);
        const target = commandRedirect(res);
        if (!target) throw new OlatError("OpenOLAT hat keinen Download-Link geliefert.");
        const dl = await this.web.downloadUnlocked(target, this.maxDownload);
        return { filename: dl.filename ?? "download", contentType: dl.contentType, data: dl.data, truncated: dl.truncated, source: `${courseId}/${nodeId}` };
      }
      if (!embed) throw new NotFoundError(`Knoten ${nodeId} zeigt keine Datei${fileIndex ? ` mit Index ${fileIndex}` : ''}. Für Ordner bitte "path" angeben.`);
      const dl = await this.web.downloadUnlocked(embed.url, this.maxDownload);
      return { filename: dl.filename ?? embed.name, contentType: dl.contentType, data: dl.data, truncated: dl.truncated, source: dl.url };
    });
    return this.toReadResult(file);
  }

  private async toReadResult(file: FileData): Promise<ReadFileResult> {
    const content = await extractContent(file, { maxInlineBinaryBytes: this.maxInline });
    const { data, ...meta } = file;
    return { file: { ...meta, size: data.length }, content, raw: data };
  }

  /** Fetches a session-bound resource URL (`/m/…`) found in page content, e.g. a linked PDF. */
  async fetchResource(url: string): Promise<ReadFileResult> {
    const file = await this.web.exclusive(async (): Promise<FileData> => {
      const dl = await this.web.downloadUnlocked(url, this.maxDownload);
      return { filename: dl.filename ?? decodeURIComponent(new URL(dl.url).pathname.split('/').pop() || 'datei'), contentType: dl.contentType, data: dl.data, truncated: dl.truncated, source: dl.url };
    });
    return this.toReadResult(file);
  }

  /** Opens any OpenOLAT page by business path or URL (e.g. `/url/HomeSite/123/effstatements/0`). */
  async openPage(pathOrUrl: string): Promise<{ title: string; url: string; markdown: string; links: LinkRef[]; files: FileRef[] }> {
    const path = toAuthPath(pathOrUrl, this.base);
    const page = await this.web.page(path);
    const c = parseNodeContent(page.html, page.url);
    return { title: page.title || c.title, url: page.url.replace(/\?oow=.*$/, ''), markdown: c.markdown, links: dedupeLinks(c.links), files: c.embeds };
  }

  // ---------------------------------------------------------------- WebDAV

  listWebDav(path = ''): Promise<DavEntry[]> {
    return this.dav.list(path);
  }

  async readWebDavFile(path: string): Promise<ReadFileResult> {
    const dl = await this.dav.download(path, this.maxDownload);
    return this.toReadResult({ filename: dl.filename, contentType: dl.contentType, data: dl.data, truncated: dl.truncated, source: `webdav:${path}` });
  }
}

function dedupeLinks(links: LinkRef[]): LinkRef[] {
  const seen = new Set<string>();
  return links.filter((l) => !seen.has(l.url) && seen.add(l.url));
}
