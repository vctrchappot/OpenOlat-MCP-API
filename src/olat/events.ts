import { ReadOnlyViolation } from './errors.js';

export type JsArg = string | number | boolean | null;

/**
 * Parses the argument list of a JavaScript call as OpenOLAT renders it in onclick handlers,
 * e.g. `o_XHREvent('/auth/1:1:2:2:1/',false,true,'cid','ctncl')`. Supports single and double
 * quoted strings with backslash escapes, numbers, booleans and null.
 */
export function parseJsArgs(src: string): JsArg[] {
  const out: JsArg[] = [];
  let i = 0;
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  while (i < src.length) {
    skipWs();
    if (i >= src.length) break;
    const c = src[i];
    if (c === "'" || c === '"') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) {
          i++;
          s += src[i];
        } else s += src[i];
        i++;
      }
      i++;
      out.push(s);
    } else {
      let tok = '';
      while (i < src.length && src[i] !== ',') tok += src[i++];
      tok = tok.trim();
      if (tok === 'true') out.push(true);
      else if (tok === 'false') out.push(false);
      else if (tok === 'null' || tok === 'undefined') out.push(null);
      else if (tok !== '' && !Number.isNaN(Number(tok))) out.push(Number(tok));
      else out.push(tok);
    }
    skipWs();
    if (src[i] === ',') i++;
  }
  return out;
}

function callArgs(onclick: string, fn: string): JsArg[] | null {
  const start = onclick.indexOf(`${fn}(`);
  if (start < 0) return null;
  let i = start + fn.length + 1;
  let depth = 1;
  let quote: string | null = null;
  for (; i < onclick.length; i++) {
    const c = onclick[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) break;
  }
  return parseJsArgs(onclick.slice(start + fn.length + 1, i));
}

/** An AJAX event targeting a component URL (o_XHREvent). */
export interface ComponentEvent {
  kind: 'component';
  url: string;
  params: Record<string, string>;
}

/** An AJAX event targeting a flexi form element (o_ffXHREvent). */
export interface FormEvent {
  kind: 'form';
  formName: string;
  dispatchUri: string;
  dispatchEvent: string;
  params: Record<string, string>;
}

export type OlatEvent = ComponentEvent | FormEvent;

function pairs(args: JsArg[], from: number): Record<string, string> {
  const params: Record<string, string> = {};
  for (let k = from; k + 1 < args.length; k += 2) params[String(args[k])] = String(args[k + 1]);
  return params;
}

export function parseEvent(onclick: string | undefined): OlatEvent | null {
  if (!onclick) return null;
  const ff = callArgs(onclick, 'o_ffXHREvent');
  if (ff) {
    return {
      kind: 'form',
      formName: String(ff[0]),
      dispatchUri: String(ff[2]),
      dispatchEvent: String(ff[4]),
      params: pairs(ff, 9),
    };
  }
  const x = callArgs(onclick, 'o_XHREvent');
  if (x) return { kind: 'component', url: String(x[0]), params: pairs(x, 3) };
  return null;
}

/**
 * Read-only guard for UI events. Only events that open views or trigger downloads are
 * allowed; anything else (subscribe, delete, upload, save, …) is rejected before a request
 * is sent. Keep this list tight: every entry must be provably side-effect free.
 */
export function assertReadOnlyEvent(ev: OlatEvent): void {
  const p = ev.params;
  const keys = Object.keys(p).filter((k) => k !== '_csrf');
  if (ev.kind === 'component') {
    // Expanding a node in the course menu tree (does not launch the node).
    if (p.cid === 'ctncl' && p.ctntr === 'open' && /^\d+$/.test(p.nidle ?? '') && keys.length === 3) return;
    // "Herunterladen" button of document and single page nodes.
    if ((p.cid === 'run.download' || p.cid === 'command.download') && keys.length === 1) return;
    throw new ReadOnlyViolation(`UI-Event ${JSON.stringify(keys.map((k) => `${k}=${p[k]}`))}`);
  }
  // Download of a row in a flexi table (folder view).
  if (keys.length === 1 && keys[0] === 'download' && /^\d+$/.test(p.download)) return;
  throw new ReadOnlyViolation(`Formular-Event ${JSON.stringify(keys)}`);
}
