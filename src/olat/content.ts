import { htmlToMarkdown } from './markdown.js';
import { extractOfficeText } from './office.js';

export interface FileData {
  filename: string;
  contentType: string;
  data: Buffer;
  truncated: boolean;
  /** Where the file came from (session-bound URL or WebDAV path). */
  source: string;
}

export type ExtractedContent =
  | { kind: 'text'; text: string; pages?: number }
  | { kind: 'image'; mimeType: string; base64: string }
  | { kind: 'binary'; mimeType: string; base64?: string; note: string };

const TEXT_EXT = /\.(txt|md|csv|json|xml|tex|py|js|ts|java|c|cpp|h|cs|html?|css|sql|yaml|yml|ini|log)$/i;

export function guessMime(filename: string, fallback: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    html: 'text/html',
    htm: 'text/html',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    zip: 'application/zip',
  };
  const base = fallback.split(';')[0].trim();
  if (base && base !== 'application/octet-stream' && base !== 'application/force-download') return base;
  return map[ext] ?? 'application/octet-stream';
}

export async function extractContent(file: FileData, opts: { maxInlineBinaryBytes: number }): Promise<ExtractedContent> {
  const mime = guessMime(file.filename, file.contentType);
  if (mime === 'application/pdf') {
    if (file.truncated) return { kind: 'binary', mimeType: mime, note: 'PDF ist zu gross für die Textextraktion.' };
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(file.data));
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      const pages = (text as string[]).map((t, i) => `--- Seite ${i + 1} ---\n${t.trim()}`).join('\n\n');
      if (pages.replace(/--- Seite \d+ ---/g, '').trim().length < 20) {
        return { kind: 'binary', mimeType: mime, note: `PDF mit ${totalPages} Seiten enthält keinen extrahierbaren Text (vermutlich gescannt).`, base64: file.data.length <= opts.maxInlineBinaryBytes ? file.data.toString('base64') : undefined };
      }
      return { kind: 'text', text: pages, pages: totalPages };
    } catch (e) {
      return { kind: 'binary', mimeType: mime, note: `PDF konnte nicht gelesen werden: ${(e as Error).message}` };
    }
  }
  if (mime === 'text/html') {
    return { kind: 'text', text: htmlToMarkdown(file.data.toString('utf8'), file.source.startsWith('http') ? file.source : undefined).markdown };
  }
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || TEXT_EXT.test(file.filename)) {
    return { kind: 'text', text: file.data.toString('utf8') + (file.truncated ? '\n\n[… gekürzt]' : '') };
  }
  if (!file.truncated && /\.(docx|pptx|xlsx)$/i.test(file.filename)) {
    const office = extractOfficeText(file.filename, file.data);
    if (office !== null) return { kind: 'text', text: office };
  }
  if (mime.startsWith('image/') && mime !== 'image/svg+xml' && !file.truncated && file.data.length <= opts.maxInlineBinaryBytes) {
    return { kind: 'image', mimeType: mime, base64: file.data.toString('base64') };
  }
  const small = !file.truncated && file.data.length <= opts.maxInlineBinaryBytes;
  return {
    kind: 'binary',
    mimeType: mime,
    base64: small ? file.data.toString('base64') : undefined,
    note: small ? 'Binärdatei (base64).' : 'Binärdatei ist zu gross zum Einbetten – über die HTTP-API herunterladen.',
  };
}
