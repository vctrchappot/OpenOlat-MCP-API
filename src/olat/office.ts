import * as cheerio from 'cheerio';
import { unzipSync, strFromU8 } from 'fflate';

/** Extracts plain text from Office Open XML files (docx, pptx, xlsx). Returns null for other formats. */
export function extractOfficeText(filename: string, data: Buffer): string | null {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext !== 'docx' && ext !== 'pptx' && ext !== 'xlsx') return null;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data), {
      filter: (f) => /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/sharedStrings\.xml|xl\/workbook\.xml|xl\/worksheets\/sheet\d+\.xml)$/.test(f.name),
    });
  } catch {
    return null;
  }
  const xml = (name: string) => (files[name] ? cheerio.load(strFromU8(files[name]), { xml: true }) : null);

  if (ext === 'docx') {
    const $ = xml('word/document.xml');
    if (!$) return null;
    return $('w\\:p')
      .toArray()
      .map((p) =>
        $(p)
          .find('w\\:t, w\\:tab, w\\:br')
          .toArray()
          .map((n) => (n.tagName === 'w:t' ? $(n).text() : n.tagName === 'w:tab' ? '\t' : '\n'))
          .join(''),
      )
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if (ext === 'pptx') {
    const slides = Object.keys(files)
      .filter((n) => n.startsWith('ppt/slides/'))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    return slides
      .map((name, i) => {
        const $ = xml(name)!;
        const paras = $('a\\:p')
          .toArray()
          .map((p) =>
            $(p)
              .find('a\\:t')
              .toArray()
              .map((t) => $(t).text())
              .join(''),
          )
          .filter((t) => t.trim());
        return `--- Folie ${i + 1} ---\n${paras.join('\n')}`;
      })
      .join('\n\n');
  }

  // xlsx
  const shared = xml('xl/sharedStrings.xml');
  const strings = shared
    ? shared('si')
        .toArray()
        .map((si) =>
          shared(si)
            .find('t')
            .toArray()
            .map((t) => shared(t).text())
            .join(''),
        )
    : [];
  const wb = xml('xl/workbook.xml');
  const names = wb ? wb('sheet').toArray().map((s) => wb(s).attr('name') ?? '') : [];
  const sheets = Object.keys(files)
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return sheets
    .map((name, i) => {
      const $ = xml(name)!;
      const rows = $('row')
        .toArray()
        .map((row) => {
          const cells: string[] = [];
          $(row)
            .find('c')
            .each((_, c) => {
              const ref = $(c).attr('r') ?? '';
              const col = colIndex(ref.replace(/\d+/g, ''));
              const t = $(c).attr('t');
              const v = $(c).find('v').first().text();
              const value = t === 's' ? (strings[Number(v)] ?? '') : t === 'inlineStr' ? $(c).find('t').text() : v;
              cells[col >= 0 ? col : cells.length] = value;
            });
          return Array.from(cells, (x) => (x ?? '').replace(/\t|\n/g, ' ')).join('\t');
        })
        .filter((r) => r.trim());
      return `--- Tabelle ${names[i] ?? i + 1} ---\n${rows.join('\n')}`;
    })
    .join('\n\n');
}

function colIndex(letters: string): number {
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
