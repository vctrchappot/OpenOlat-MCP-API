import * as cheerio from 'cheerio';
import { commandHtml, commandRedirect, parseCommandResponse, type CommandResponse } from './commands.js';
import { CookieJar } from './cookies.js';
import { OlatAuthError, OlatError, ReadOnlyViolation } from './errors.js';
import { assertReadOnlyEvent, type OlatEvent } from './events.js';

export interface Credentials {
  username: string;
  password: string;
}

export interface WebPage {
  url: string;
  /** Full HTML, or the concatenated fragments of a command response. */
  html: string;
  title: string;
}

const USER_AGENT = 'openolat-api-mcp/1.0 (read-only; +https://github.com/vctrchappot)';
const TIMEOUT_MS = 45_000;

/**
 * Checks that a GET request cannot trigger an action. OpenOLAT dispatches UI events through
 * component URLs such as `/auth/1%3A1%3A123%3A2%3A0%3Acid%3Alogout/`, so only business paths
 * (`/auth/RepositoryEntry/…`), mapper resources (`/m/…`) and static resources are allowed.
 */
export function assertSafeGet(url: URL, base: URL): void {
  if (url.origin !== base.origin) throw new ReadOnlyViolation(`fremde URL ${url.origin}`);
  const p = url.pathname;
  if (/^\/(m|raw)\//.test(p)) return;
  if (p === '/dmz/' || p === '/dmz') return;
  if (/^\/(auth|url)\/[A-Za-z]/.test(p) || p === '/auth/' || p === '/url/') return;
  throw new ReadOnlyViolation(`GET ${p}`);
}

/** A logged-in browser-like session against the OpenOLAT web UI. Requests are serialized. */
export class OlatWebSession {
  private readonly jar = new CookieJar();
  private windowId = '';
  private loggedIn = false;
  private chain: Promise<unknown> = Promise.resolve();
  lastUsed = Date.now();

  constructor(
    readonly base: URL,
    private readonly creds: Credentials,
  ) {}

  /** Runs `fn` exclusively: OpenOLAT keeps per-window UI state, so parallel requests would interfere. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    this.lastUsed = Date.now();
    return run;
  }

  private async raw(url: URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('user-agent', USER_AGENT);
    headers.set('accept-language', 'de-CH,de;q=0.9');
    const cookie = this.jar.header();
    if (cookie) headers.set('cookie', cookie);
    const res = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    this.jar.store(res);
    return res;
  }

  /** GET with redirect handling, including OpenOLAT's `window.name` reload trick. */
  private async get(path: string | URL): Promise<{ url: URL; res: Response; text: string }> {
    let url = new URL(path, this.base);
    for (let hop = 0; hop < 12; hop++) {
      assertSafeGet(url, this.base);
      const res = await this.raw(url);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url);
        continue;
      }
      const ow = url.searchParams.get('oow');
      if (ow) this.windowId = ow;
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('html')) return { url, res, text: '' };
      const text = await res.text();
      const reload = text.length < 2000 && text.match(/window\.location\.replace\("([^"]*)" \+ window\.name\)/);
      if (reload) {
        url = new URL(reload[1] + this.windowId, url);
        continue;
      }
      return { url, res, text };
    }
    throw new OlatError('Zu viele Weiterleitungen');
  }

  private async postForm(url: URL, body: URLSearchParams, xhr = false): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (xhr) {
      headers['x-requested-with'] = 'XMLHttpRequest';
      headers.accept = 'application/json, text/javascript, */*';
    }
    const res = await this.raw(url, { method: 'POST', body, headers });
    if (res.status >= 400) throw new OlatError(`OpenOLAT antwortete mit HTTP ${res.status}`, res.status);
    return res.text();
  }

  private static loginForm(html: string) {
    const $ = cheerio.load(html);
    const form = $('form#ofo_oolat_login');
    if (!form.length) return null;
    const fields = new URLSearchParams();
    form.find('input').each((_, e) => {
      const name = $(e).attr('name');
      if (name && $(e).attr('type') !== 'checkbox') fields.set(name, $(e).attr('value') ?? '');
    });
    const error = $('.o_error, .o_warning, .has-error .help-block, .o_login_error').text().replace(/\s+/g, ' ').trim();
    return { action: form.attr('action')!, fields, error, html };
  }

  private async login(): Promise<void> {
    this.jar.clear();
    this.windowId = '';
    const start = await this.get('/dmz/');
    let form = OlatWebSession.loginForm(start.text);
    if (!form) throw new OlatError('Login-Formular nicht gefunden (Seitenlayout geändert?)');

    // Step 1: username
    form.fields.set('o_fiooolat_login_name', this.creds.username);
    form.fields.set('dispatchuri', 'o_fiooolat_login_button');
    form.fields.set('dispatchevent', '2');
    let text = await this.postForm(new URL(form.action, this.base), form.fields);
    let cmds = parseCommandResponse(text);
    form = OlatWebSession.loginForm(cmds ? commandHtml(cmds) : text);
    if (!form || !form.fields.has('o_fiooolat_login_pass')) throw new OlatAuthError();

    // Step 2: password
    form.fields.set('o_fiooolat_login_pass', this.creds.password);
    form.fields.set('dispatchuri', 'o_fiooolat_login_button');
    form.fields.set('dispatchevent', '2');
    text = await this.postForm(new URL(form.action, this.base), form.fields);
    cmds = parseCommandResponse(text);
    const target = cmds && commandRedirect(cmds);
    if (!target) throw new OlatAuthError();
    await this.get(target);
    this.loggedIn = true;
  }

  private static isLoginPage(url: URL, html: string): boolean {
    return url.pathname.startsWith('/dmz') || html.includes('id="ofo_oolat_login"');
  }

  private async ensureLogin(): Promise<void> {
    if (!this.loggedIn) await this.login();
  }

  /** Verifies the credentials by logging in. */
  verify(): Promise<void> {
    return this.exclusive(() => this.login());
  }

  /** Opens a business path (e.g. `/auth/RepositoryEntry/123/CourseNode/456`) and returns its HTML. */
  page(path: string): Promise<WebPage> {
    return this.exclusive(() => this.pageUnlocked(path));
  }

  async pageUnlocked(path: string): Promise<WebPage> {
    await this.ensureLogin();
    let r = await this.get(path);
    if (OlatWebSession.isLoginPage(r.url, r.text)) {
      await this.login();
      r = await this.get(path);
      if (OlatWebSession.isLoginPage(r.url, r.text)) throw new OlatAuthError('Sitzung konnte nicht wiederhergestellt werden.');
    }
    const cmds = parseCommandResponse(r.text);
    const html = cmds ? commandHtml(cmds) : r.text;
    const title = cheerio.load(html)('title').first().text().trim() || cmds?.documentTitle || '';
    return { url: r.url.href, html, title };
  }

  /**
   * Fires an allow-listed UI event (see `assertReadOnlyEvent`). For form events the page HTML is
   * needed to resolve the form's action URL and CSRF token. Must be called inside `exclusive`.
   */
  async eventUnlocked(ev: OlatEvent, pageHtml: string): Promise<CommandResponse> {
    assertReadOnlyEvent(ev);
    let url: URL;
    const body = new URLSearchParams();
    if (ev.kind === 'component') {
      url = new URL(ev.url, this.base);
      for (const [k, v] of Object.entries(ev.params)) body.set(k, v);
    } else {
      const $ = cheerio.load(pageHtml);
      const form = $(`form#${ev.formName}`);
      if (!form.length) throw new OlatError(`Formular ${ev.formName} nicht gefunden`);
      url = new URL(form.attr('action')!, this.base);
      body.set('_csrf', form.find("input[name='_csrf']").attr('value') ?? '');
      body.set('dispatchuri', ev.dispatchUri);
      body.set('dispatchevent', ev.dispatchEvent);
      for (const [k, v] of Object.entries(ev.params)) body.set(k, v);
    }
    if (url.origin !== this.base.origin || !url.pathname.startsWith('/auth/')) throw new ReadOnlyViolation(`POST ${url.pathname}`);
    const text = await this.postForm(url, body, true);
    const cmds = parseCommandResponse(text);
    if (!cmds) throw new OlatError('Unerwartete Antwort auf UI-Event');
    return cmds;
  }

  /** Downloads a session-bound resource (mapper URL `/m/…`). Must be called inside `exclusive`. */
  async downloadUnlocked(path: string, maxBytes: number): Promise<{ url: string; contentType: string; filename?: string; data: Buffer; truncated: boolean; size?: number }> {
    await this.ensureLogin();
    const url = new URL(path, this.base);
    assertSafeGet(url, this.base);
    let res = await this.raw(url);
    for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop++) {
      const next = new URL(res.headers.get('location')!, url);
      assertSafeGet(next, this.base);
      res = await this.raw(next);
    }
    if (!res.ok) throw new OlatError(`Download fehlgeschlagen (HTTP ${res.status})`, res.status);
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const cd = res.headers.get('content-disposition') ?? '';
    const fnStar = cd.match(/filename\*=UTF-8''([^;]+)/i);
    const fnPlain = cd.match(/filename="?([^";]+)"?/i);
    const filename = fnStar ? decodeURIComponent(fnStar[1]) : fnPlain?.[1];
    const size = Number(res.headers.get('content-length')) || undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
    }
    return { url: url.href, contentType, filename, data: Buffer.concat(chunks), truncated, size };
  }
}
