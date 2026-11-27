import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

export interface LinkRef {
  text: string;
  url: string;
}

export interface MarkdownResult {
  markdown: string;
  links: LinkRef[];
  images: LinkRef[];
}

const SKIP = new Set(['script', 'style', 'noscript', 'button', 'select', 'input', 'textarea', 'svg', 'template', 'head']);

function clean(s: string): string {
  return s.replace(/[ \t\r\n ]+/g, ' ');
}

/**
 * Converts an HTML fragment to compact Markdown. Relative links are resolved against `baseUrl`;
 * JavaScript-only links are rendered as plain text.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): MarkdownResult {
  const $ = cheerio.load(html);
  const links: LinkRef[] = [];
  const images: LinkRef[] = [];

  const abs = (href: string | undefined): string | null => {
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) return null;
    try {
      const url = baseUrl ? new URL(href, baseUrl) : new URL(href);
      // OpenOLAT component/event URLs (`/auth/1:1:123:…`) only work inside the browser window.
      if (/^\/(auth|m)\/\d+(:|%3A)/i.test(url.pathname)) return null;
      return url.href;
    } catch {
      return null;
    }
  };

  const inline = (nodes: AnyNode[]): string => nodes.map(render).join('');

  function render(node: AnyNode): string {
    if (node.type === 'text') return clean((node as any).data ?? '');
    if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return '';
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return '';
    const $el = $(el);
    if ($el.attr('aria-hidden') === 'true' || $el.hasClass('sr-only') || $el.attr('style')?.includes('display:none')) return '';
    const kids = () => inline(el.children);
    switch (tag) {
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const t = kids().trim();
        return t ? `\n\n${'#'.repeat(Number(tag[1]))} ${t}\n\n` : '';
      }
      case 'p':
      case 'div':
      case 'section':
      case 'article':
      case 'header':
      case 'footer':
      case 'fieldset':
      case 'form':
      case 'figure':
      case 'figcaption':
      case 'dl':
        return `\n\n${kids()}\n\n`;
      case 'dt':
        return `\n**${kids().trim()}**`;
      case 'dd':
        return `\n: ${kids().trim()}`;
      case 'blockquote':
        return `\n\n${kids()
          .trim()
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}\n\n`;
      case 'pre':
        return `\n\n\`\`\`\n${$el.text()}\n\`\`\`\n\n`;
      case 'code':
        return `\`${$el.text()}\``;
      case 'strong':
      case 'b': {
        const t = kids();
        return t.trim() ? `**${t.trim()}** ` : t;
      }
      case 'em':
      case 'i': {
        if ($el.hasClass('o_icon')) return '';
        const t = kids();
        return t.trim() ? `*${t.trim()}* ` : t;
      }
      case 'ul':
      case 'ol': {
        const items = $el.children('li').toArray();
        const ordered = tag === 'ol';
        const body = items
          .map((li, idx) => {
            const t = inline(li.children).trim().replace(/\n{2,}/g, '\n').replace(/\n/g, '\n   ');
            return t ? `${ordered ? `${idx + 1}.` : '-'} ${t}` : '';
          })
          .filter(Boolean)
          .join('\n');
        return `\n\n${body}\n\n`;
      }
      case 'li':
        return `\n- ${kids().trim()}`;
      case 'a': {
        const text = kids().trim();
        const url = abs($el.attr('href'));
        if (!url) return text;
        if (text) links.push({ text, url });
        return text ? `[${text}](${url})` : '';
      }
      case 'img': {
        const url = abs($el.attr('src'));
        const alt = clean($el.attr('alt') ?? '').trim();
        if (!url) return '';
        images.push({ text: alt, url });
        return `![${alt}](${url})`;
      }
      case 'iframe': {
        const url = abs($el.attr('src'));
        return url ? `\n\n[Eingebetteter Inhalt](${url})\n\n` : '';
      }
      case 'video':
      case 'audio': {
        const src = $el.attr('src') ?? $el.find('source').attr('src');
        const url = abs(src);
        return url ? `\n\n[${tag === 'video' ? 'Video' : 'Audio'}](${url})\n\n` : '';
      }
      case 'table':
        return `\n\n${renderTable(el)}\n\n`;
      default:
        return kids();
    }
  }

  function renderTable(table: Element): string {
    const rows = $(table)
      .find('tr')
      .toArray()
      .filter((tr) => $(tr).closest('table')[0] === table);
    const matrix = rows
      .map((tr) =>
        $(tr)
          .children('th,td')
          .toArray()
          .map((c) => inline(c.children).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()),
      )
      .filter((r) => r.some((c) => c));
    if (!matrix.length) return '';
    const width = Math.max(...matrix.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
    const [head, ...body] = matrix.map(pad);
    return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  }

  const root = $('body').length ? $('body')[0] : $.root()[0];
  const md = inline((root as Element).children)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^ +(?![-\d>|])/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown: md, links, images };
}
