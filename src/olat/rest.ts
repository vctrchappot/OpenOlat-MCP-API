import { OlatAuthError, OlatError, NotFoundError } from './errors.js';
import type { Credentials } from './web.js';

/** Read-only client for the OpenOLAT REST API (`/restapi`). Only GET requests are possible. */
export class OlatRestClient {
  private readonly auth: string;

  constructor(
    private readonly base: URL,
    creds: Credentials,
  ) {
    this.auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  }

  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`/restapi/${path.replace(/^\//, '')}`, this.base);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: this.auth, accept: 'application/json' },
      signal: AbortSignal.timeout(45_000),
    });
    if (res.status === 401) throw new OlatAuthError();
    if (res.status === 403) throw new OlatError(`Kein Zugriff auf ${url.pathname} (403)`, 403);
    if (res.status === 404) throw new NotFoundError(`Nicht gefunden: ${url.pathname}`);
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw new OlatError(`REST ${url.pathname} → HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  }
}

export interface RestUser {
  key: number;
  firstName: string;
  lastName: string;
  email: string;
}

export interface RestCourse {
  key: number;
  displayName: string;
  title: string;
  description: string | null;
  repoEntryKey: number;
  repoEntryStatus: string;
  externalRef?: string | null;
  nodeAccessType?: string;
  authors?: string | null;
}

export interface RestGroup {
  key: number;
  name: string;
  description: string | null;
  type: string;
}

export interface RestFolder {
  name: string;
  detailsName: string | null;
  groupKey: number | null;
  courseKey: number | null;
  courseNodeId: string | null;
}

export interface RestCalendar {
  id: string;
  type: string;
  displayName: string;
}

export interface RestEvent {
  id: string;
  subject: string;
  description: string | null;
  location: string | null;
  calendarId: string;
  begin: number;
  end: number;
  allDayEvent: boolean;
  links?: { displayName: string; uri: string }[];
}

export interface RestNotification {
  key: number;
  type: string;
  title: string;
  items: { link: string; date: number; description: string; courseNodeId?: string | null }[];
}
