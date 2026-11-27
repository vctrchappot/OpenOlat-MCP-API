/**
 * OpenOLAT answers form posts and AJAX events with a list of "commands" (redraw component,
 * redirect, …). In non-AJAX mode the same list is wrapped in a tiny HTML page as `var r={...}`.
 */
export interface OlatCommand {
  w?: string;
  cmd: number;
  cda: Record<string, any>;
}

export interface CommandResponse {
  cmds: OlatCommand[];
  businessPath?: string;
  documentTitle?: string;
}

function extractObjectAfter(text: string, marker: string): any | null {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, j + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Parses either a JSON command response or the HTML-wrapped variant. */
export function parseCommandResponse(text: string): CommandResponse | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (Array.isArray(obj.cmds)) return obj;
    } catch {
      /* fall through */
    }
  }
  if (text.length < 2_000_000 && text.includes('var r={')) {
    const obj = extractObjectAfter(text, 'var r=');
    if (obj && Array.isArray(obj.cmds)) return obj;
  }
  return null;
}

/** Concatenated HTML of all redraw commands. */
export function commandHtml(res: CommandResponse): string {
  const parts: string[] = [];
  for (const c of res.cmds) {
    if (c.cmd === 2) for (const cp of c.cda?.cps ?? []) if (cp.hfrag) parts.push(cp.hfrag);
  }
  return parts.join('\n');
}

/** Target of a redirect command (cmd 5), e.g. after login or for a download. */
export function commandRedirect(res: CommandResponse): string | null {
  const c = res.cmds.find((x) => x.cmd === 5 && x.cda?.rurl);
  return c ? String(c.cda.rurl) : null;
}
