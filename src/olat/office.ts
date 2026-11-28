import * as cheerio from 'cheerio';
import { unzipSync, strFromU8 } from 'fflate';

export interface XlsxSheet {
  name: string;
  hidden: boolean;
  /** Rows of cell texts; date cells are rendered as `dd.mm.yyyy` (plus ` hh:mm` if they carry a time). */
  rows: string[][];
}

const XLSX_FILES = /^(xl\/sharedStrings\.xml|xl\/styles\.xml|xl\/workbook\.xml|xl\/worksheets\/sheet\d+\.xml)$/;

/** Built-in number formats that Excel displays as date/time. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(stripped);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Excel serial number (days since 1899-12-30) to `dd.mm.yyyy[ hh:mm]`. */
export function excelSerialToText(serial: number): string {
  const ms = Math.round(serial * 86_400_000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  const time = serial % 1 > 0.0001 ? ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : '';
  if (serial < 1) return time.trim();
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}${time}`;
}

function colIndex(letters: string): number {
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsx(files: Record<string, Uint8Array>): XlsxSheet[] {
  const xml = (name: string) => (files[name] ? cheerio.load(strFromU8(files[name]), { xml: true }) : null);

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

  // Which cell styles are date formats.
  const styles = xml('xl/styles.xml');
  const customDates = new Set<number>();
  const dateStyle: boolean[] = [];
  if (styles) {
    styles('numFmts numFmt').each((_, f) => {
      if (isDateFormatCode(styles(f).attr('formatCode') ?? '')) customDates.add(Number(styles(f).attr('numFmtId')));
    });
    styles('cellXfs xf').each((_, xf) => {
      const id = Number(styles(xf).attr('numFmtId') ?? 0);
      dateStyle.push(BUILTIN_DATE_FORMATS.has(id) || customDates.has(id));
    });
  }

  const wb = xml('xl/workbook.xml');
  const meta = wb ? wb('sheet').toArray().map((s) => ({ name: wb(s).attr('name') ?? '', hidden: (wb(s).attr('state') ?? 'visible') !== 'visible' })) : [];
  const sheetFiles = Object.keys(files)
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

  return sheetFiles.map((name, i) => {
    const $ = xml(name)!;
    const rows = $('row')
      .toArray()
      .map((row) => {
        const cells: string[] = [];
        $(row)
          .find('c')
          .each((_, c) => {
            const col = colIndex(($(c).attr('r') ?? '').replace(/\d+/g, ''));
            const t = $(c).attr('t');
            const v = $(c).find('v').first().text();
            let value: string;
            if (t === 's') value = strings[Number(v)] ?? '';
            else if (t === 'inlineStr') value = $(c).find('t').text();
            else if (!t || t === 'n') value = v !== '' && dateStyle[Number($(c).attr('s') ?? 0)] && Number.isFinite(Number(v)) ? excelSerialToText(Number(v)) : v;
            else value = v;
            cells[col >= 0 ? col : cells.length] = value;
          });
        return Array.from(cells, (x) => (x ?? '').replace(/\t|\n/g, ' '));
      })
      .filter((r) => r.some((x) => x.trim()));
    return { name: meta[i]?.name ?? String(i + 1), hidden: meta[i]?.hidden ?? false, rows };
  });
}

/** Reads all sheets of an xlsx file as text cells (dates are converted). Returns null if the data is not a readable xlsx. */
export function readXlsx(data: Buffer): XlsxSheet[] | null {
  try {
    return parseXlsx(unzipSync(new Uint8Array(data), { filter: (f) => XLSX_FILES.test(f.name) }));
  } catch {
    return null;
  }
}

/** Extracts plain text from Office Open XML files (docx, pptx, xlsx). Returns null for other formats. */
export function extractOfficeText(filename: string, data: Buffer): string | null {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext !== 'docx' && ext !== 'pptx' && ext !== 'xlsx') return null;

  if (ext === 'xlsx') {
    const sheets = readXlsx(data);
    if (!sheets) return null;
    return sheets
      .filter((s) => !s.hidden)
      .map((s) => `--- Tabelle ${s.name} ---\n${s.rows.map((r) => r.join('\t')).join('\n')}`)
      .join('\n\n');
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data), {
      filter: (f) => /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml)$/.test(f.name),
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
