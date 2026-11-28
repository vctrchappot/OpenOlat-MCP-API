import type { CourseNodeView, CourseSummary, CourseTreeNode, FolderView, ReadFileResult } from './client.js';
import { NotFoundError } from './errors.js';
import { parseInfoMessages, type InfoMessage } from './infomessages.js';
import { embedCandidates, type LandingPage } from './landing.js';
import { resolveUrl } from './resolve.js';
import type { RestCalendar, RestEvent } from './rest.js';

/** The part of the client that URL resolution needs (kept narrow so it can be tested with a stub). */
export interface UrlClient {
  readonly baseUrl: URL;
  readonly allowedExternalHosts: string[];
  getCourseInfo(courseId: number): Promise<CourseSummary & { folders: { nodeId: string; title: string }[] }>;
  getCourseTree(courseId: number): Promise<CourseTreeNode[]>;
  getCourseNode(courseId: number, nodeId: string): Promise<CourseNodeView>;
  listFolder(courseId: number, nodeId: string, path?: string): Promise<FolderView>;
  readFile(courseId: number, nodeId: string, path?: string, fileIndex?: number): Promise<ReadFileResult>;
  fetchResource(url: string): Promise<ReadFileResult>;
  readWebDavFile(path: string): Promise<ReadFileResult>;
  openPage(pathOrUrl: string): Promise<{ title: string; url: string; markdown: string; files: { name: string; url: string }[] }>;
  listCalendars(): Promise<RestCalendar[]>;
  listEvents(from?: Date, to?: Date, calendarId?: string): Promise<(RestEvent & { calendar?: string })[]>;
  landingFromCandidates(candidates: string[], opts?: { from?: string; to?: string }): Promise<LandingPage | null>;
}

export interface FetchOptions {
  /** Period for landing pages and calendars (ISO dates). */
  from?: string;
  to?: string;
  /** Only info messages published or edited on or after this day (ISO date). */
  since?: string;
  /** Sub-path in a folder node (a file with an extension is read, anything else is listed). */
  path?: string;
  /** Which file to read if a node shows several. */
  fileIndex?: number;
}

export type FetchResult =
  | { action: 'course'; course: CourseSummary & { folders: { nodeId: string; title: string }[] }; tree: CourseTreeNode[] }
  | { action: 'info_messages'; title: string; url: string; messages: InfoMessage[] }
  | { action: 'landing_page'; page: LandingPage }
  | { action: 'folder'; title: string; url: string; folder: FolderView }
  | { action: 'calendar'; title: string; url: string; events: (RestEvent & { calendar?: string })[] }
  | { action: 'file'; file: ReadFileResult }
  | { action: 'node'; node: CourseNodeView }
  | { action: 'page'; page: { title: string; url: string; markdown: string; files: { name: string; url: string }[] } };

const MAX_MESSAGES = 20;
const looksLikeFile = (path: string) => /\.[A-Za-z0-9]{1,6}$/.test(path.split('/').pop() ?? '');

/**
 * One entry point for "here is a URL, give me what is behind it": picks the right read action from the URL and,
 * for course nodes, from the node type (messages, landing page, folder, document, calendar, page).
 */
export async function fetchByUrl(client: UrlClient, input: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const target = resolveUrl(input, client.baseUrl, client.allowedExternalHosts);

  switch (target.kind) {
    case 'landing': {
      const page = await client.landingFromCandidates([target.url], opts);
      if (!page) throw new NotFoundError('Diese Landing Page konnte nicht gelesen werden.');
      return { action: 'landing_page', page };
    }
    case 'resource':
      return { action: 'file', file: await client.fetchResource(target.url) };
    case 'webdav':
      return { action: 'file', file: await client.readWebDavFile(target.path) };
    case 'page':
      return { action: 'page', page: await client.openPage(target.path) };
    case 'course': {
      const [course, tree] = await Promise.all([client.getCourseInfo(target.courseId), client.getCourseTree(target.courseId)]);
      return { action: 'course', course, tree };
    }
    case 'node':
      return fetchNode(client, target.courseId, target.nodeId, opts);
  }
}

async function fetchNode(client: UrlClient, courseId: number, nodeId: string, opts: FetchOptions): Promise<FetchResult> {
  const node = await client.getCourseNode(courseId, nodeId);
  if (!node.opened) throw new NotFoundError(`Baustein ${nodeId} in Kurs ${courseId} ist nicht zugänglich.`);

  // An explicit sub-path or file index asks for a file or a folder listing.
  if (opts.path !== undefined && opts.path !== '') {
    if (looksLikeFile(opts.path)) return { action: 'file', file: await client.readFile(courseId, nodeId, opts.path, opts.fileIndex ?? 0) };
    if (node.folder) return { action: 'folder', title: node.title, url: node.url, folder: await client.listFolder(courseId, nodeId, opts.path) };
  }
  if (opts.fileIndex !== undefined && node.files.length) {
    return { action: 'file', file: await client.readFile(courseId, nodeId, undefined, opts.fileIndex) };
  }

  if (node.type === 'info-messages') {
    const all = parseInfoMessages(node.markdown);
    const since = opts.since?.slice(0, 10);
    const messages = (since ? all.filter((m) => (m.edited ?? m.published ?? '9999') >= since) : all).slice(0, MAX_MESSAGES);
    return { action: 'info_messages', title: node.title, url: node.url, messages };
  }

  const landing = await client.landingFromCandidates(embedCandidates(node), opts);
  if (landing) return { action: 'landing_page', page: landing };

  if (node.folder) return { action: 'folder', title: node.title, url: node.url, folder: node.folder };
  if (node.type === 'calendar') {
    const course = await client.getCourseInfo(courseId);
    const calendar = (await client.listCalendars()).find((c) => c.displayName === course.title);
    const events = await client.listEvents(opts.from ? new Date(opts.from) : undefined, opts.to ? new Date(opts.to) : undefined, calendar?.id);
    return { action: 'calendar', title: node.title, url: node.url, events };
  }
  if (node.downloadable && !node.files.length) return { action: 'file', file: await client.readFile(courseId, nodeId) };
  return { action: 'node', node };
}
