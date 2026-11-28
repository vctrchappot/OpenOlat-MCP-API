/**
 * "Aufgaben / Mitteilungen" course nodes (info-messages) render every message as
 *
 *   2026 / NOV / 26 / ### Titel / Publiziert von … am 26.11.2026, 15:09 / [Geändert von … am …] / text
 *
 * The notification feed only says that a message exists; the text lives in this node.
 */

export interface InfoMessage {
  title: string;
  /** ISO date (Europe/Zurich) of the first publication, if shown. */
  published?: string;
  publishedBy?: string;
  /** ISO date of the last edit, if shown. */
  edited?: string;
  text: string;
}

const DATE_BLOCK = /(?:^|\n)\d{4}\n\n[A-Za-zÄÖÜäöü.]{2,5}\n\n\d{1,2}\n\n### (.+)\n/g;
const META = /^(Publiziert|Geändert) von (.+?) am (\d{2})\.(\d{2})\.(\d{4})(?:, \d{2}:\d{2})?\s*$/;

export function parseInfoMessages(markdown: string): InfoMessage[] {
  const hits = [...markdown.matchAll(DATE_BLOCK)];
  return hits.map((hit, i) => {
    const start = (hit.index ?? 0) + hit[0].length;
    const end = i + 1 < hits.length ? (hits[i + 1].index ?? markdown.length) : markdown.length;
    const message: InfoMessage = { title: hit[1].trim(), text: '' };
    const body: string[] = [];
    let inMeta = true;
    for (const line of markdown.slice(start, end).split('\n')) {
      const meta = inMeta ? META.exec(line.trim()) : null;
      if (meta) {
        const iso = `${meta[5]}-${meta[4]}-${meta[3]}`;
        if (meta[1] === 'Publiziert') {
          message.published = iso;
          message.publishedBy = meta[2];
        } else message.edited = iso;
        continue;
      }
      if (inMeta && !line.trim()) continue;
      inMeta = false;
      body.push(line);
    }
    message.text = body.join('\n').trim();
    return message;
  });
}

/** Course and node of a notification link `…/RepositoryEntry/{id}/CourseNode/{id}/InfoMessage/{id}`. */
export function infoMessageTarget(link: string): { courseId: number; nodeId: string } | null {
  const m = /\/RepositoryEntry\/(\d+)\/CourseNode\/(\d+)\/InfoMessage\//.exec(link);
  return m ? { courseId: Number(m[1]), nodeId: m[2] } : null;
}

/** The message a feed item refers to: same title, preferably the one published or edited on the item's day. */
export function matchInfoMessage(messages: InfoMessage[], item: { description: string; date: number }): InfoMessage | undefined {
  const title = /Mitteilung "(.+?)" (?:veröffentlicht|bearbeitet)/.exec(item.description)?.[1]?.trim();
  if (!title) return undefined;
  const same = messages.filter((m) => m.title === title);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date(item.date));
  return same.find((m) => m.published === day || m.edited === day) ?? same[0];
}
