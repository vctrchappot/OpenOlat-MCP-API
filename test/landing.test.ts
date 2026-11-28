import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { infoMessageTarget, matchInfoMessage, parseInfoMessages } from '../src/olat/infomessages.js';
import { cleanMarkup, landingDataUrl, parseLanding, toIsoDate } from '../src/olat/landing.js';
import { excelSerialToText, extractOfficeText, readXlsx } from '../src/olat/office.js';

const HOSTS = ['landingpage.bmsw-server.ch'];

describe('xlsx dates', () => {
  it('converts Excel serial numbers', () => {
    expect(excelSerialToText(46254)).toBe('20.08.2026');
    expect(excelSerialToText(46254.5)).toBe('20.08.2026 12:00');
  });

  it('renders only date-formatted cells as dates', () => {
    const files = {
      'xl/styles.xml': strToU8(
        '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
      ),
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Plan"/></sheets></workbook>'),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row><c r="A1" s="1"><v>46254</v></c><c r="B1" s="2"><v>46261</v></c><c r="C1" s="0"><v>46254</v></c></row></sheetData></worksheet>',
      ),
    };
    const buf = Buffer.from(zipSync(files));
    expect(readXlsx(buf)?.[0].rows[0]).toEqual(['20.08.2026', '27.08.2026', '46254']);
    expect(extractOfficeText('p.xlsx', buf)).toBe('--- Tabelle Plan ---\n20.08.2026\t27.08.2026\t46254');
  });
});

describe('landing page mini syntax', () => {
  it('cleans nested markup, links, deadlines and colours', () => {
    expect(cleanMarkup('rot(fett(Prüfung Melody))')).toBe('Prüfung Melody [rot]');
    expect(cleanMarkup('Link(Skript; https://olat.example/x)')).toBe('Skript (https://olat.example/x)');
    expect(cleanMarkup('Abgabe(Aufgabe A, B und C; 05.05.2026; Teams)')).toBe('Abgabe: Aufgabe A, B und C bis 05.05.2026 (Teams)');
    expect(cleanMarkup('LNW(Kurztest; 13.05.2026)')).toBe('Leistungsnachweis: Kurztest bis 13.05.2026');
    expect(cleanMarkup('PETROL(neu: Blatt 3)')).toBe('neu: Blatt 3 [neu]');
    expect(cleanMarkup('Achtung(bleibt)')).toBe('Achtung(bleibt)');
  });

  it('resolves #shortcuts', () => {
    const shortcuts = new Map([['#kap3', 'Link(Kapitel 3; https://x.ch/k3.pdf)']]);
    expect(cleanMarkup('Lesen: #Kap3', shortcuts)).toBe('Lesen: Kapitel 3 (https://x.ch/k3.pdf)');
  });
});

describe('landing page data', () => {
  it('only accepts https embeds of allowed hosts with a valid id', () => {
    const ok = 'https://landingpage.bmsw-server.ch/bmsw_lp-v20.html?id=lp-abc123/LT26l_Deutsch';
    expect(landingDataUrl([ok], HOSTS)?.href).toBe('https://landingpage.bmsw-server.ch/data/lp-abc123/LT26l_Deutsch.xlsx');
    expect(landingDataUrl([ok], ['other.example'])).toBeNull();
    expect(landingDataUrl([ok.replace('https', 'http')], HOSTS)).toBeNull();
    expect(landingDataUrl(['https://landingpage.bmsw-server.ch/x.html?id=../../etc/passwd'], HOSTS)).toBeNull();
    expect(landingDataUrl(['https://evil.example/x.html?id=lp-abc123'], HOSTS)).toBeNull();
    expect(landingDataUrl(['not a url', 'https://landingpage.bmsw-server.ch/x.html'], HOSTS)).toBeNull();
  });

  const sheets = [
    {
      name: 'Lektionen',
      hidden: false,
      rows: [
        ['Verbergen', 'Datum', 'Zeit', 'Thema', 'Ablauf/Material', 'Aufgaben', 'Lernziele', 'Zusatzspalte'],
        ['x', '20.08.2026', '07:35–09:10', '', '', '', '', ''],
        ['', '12.11.2026', '07:35–09:10', 'Grammatik', 'Wortarten', 'rot(fett(Prüfung Melody))', '', ''],
        ['', '19.11.2026', '07:35–09:10', '', '', '', '', ''],
        ['', '26.11.2026', '07:35–09:10', 'Grammatik', '#Kap3', 'Abgabe(Spick; 03.12.2026; Teams)', 'Wortarten kennen', ''],
        ['', '03.12.2026', '07:35–09:10', 'fett(fällt aus)', '', '', '', ''],
      ],
    },
    { name: 'Verzeichnis', hidden: false, rows: [['Kürzel', 'Text', 'Funktion', 'Ziel'], ['#Kap3', 'Kapitel 3', 'Link', 'https://x.ch/k3.pdf']] },
    {
      name: 'Info',
      hidden: false,
      rows: [['key', 'value'], ['title', 'LT26l · Deutsch'], ['teacher', 'Lehrperson: Muster'], ['fixedInfo', 'Zimmer 214'], ['fixedInfo', 'Fragen: m@x.ch']],
    },
    { name: 'Status', hidden: true, rows: [['Datum']] },
  ];

  it('returns upcoming lessons with cleaned text, skipping hidden and empty rows', () => {
    const page = parseLanding(sheets, { from: '2026-11-20' });
    expect(page.title).toBe('LT26l · Deutsch');
    expect(page.infos).toEqual(['Zimmer 214', 'Fragen: m@x.ch']);
    expect(page.lessons).toEqual([
      { date: '2026-11-26', time: '07:35–09:10', topic: 'Grammatik', material: 'Kapitel 3 (https://x.ch/k3.pdf)', tasks: 'Abgabe: Spick bis 03.12.2026 (Teams)', goals: 'Wortarten kennen' },
      { date: '2026-12-03', time: '07:35–09:10', topic: 'fällt aus' },
    ]);
    expect(page.hidden).toBe(1);
    expect(page.truncated).toBe(false);
  });

  it('applies the period and keeps exams marked red', () => {
    const page = parseLanding(sheets, { from: '2026-11-01', to: '2026-11-15' });
    expect(page.lessons.map((l) => l.date)).toEqual(['2026-11-12']);
    expect(page.lessons[0].tasks).toBe('Prüfung Melody [rot]');
  });

  it('reads Excel and ISO dates', () => {
    expect(toIsoDate('5.3.2026')).toBe('2026-03-05');
    expect(toIsoDate('2026-03-05T10:00')).toBe('2026-03-05');
    expect(toIsoDate('bald')).toBeNull();
  });
});

describe('info messages', () => {
  const markdown = `## Aufgaben / Mitteilungen

2026

NOV

26

### Hausaufgaben

Publiziert von Pfalzgraf, Wolfgang am 26.11.2026, 15:09

Geändert von Pfalzgraf, Wolfgang am 27.11.2026, 08:12

**Hausaufgaben / Prüfungsvorbereitung** :
Lösen Sie Aufgabe 5.

2026

NOV

12

### Hausaufgaben

Publiziert von Pfalzgraf, Wolfgang am 12.11.2026, 17:41

Lösen Sie Aufgabe 3.
`;

  it('splits messages and reads dates and text', () => {
    const messages = parseInfoMessages(markdown);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      title: 'Hausaufgaben',
      published: '2026-11-26',
      publishedBy: 'Pfalzgraf, Wolfgang',
      edited: '2026-11-27',
      text: '**Hausaufgaben / Prüfungsvorbereitung** :\nLösen Sie Aufgabe 5.',
    });
    expect(messages[1].text).toBe('Lösen Sie Aufgabe 3.');
    expect(messages[1].edited).toBeUndefined();
  });

  it('matches a feed item to its message by title and day', () => {
    const messages = parseInfoMessages(markdown);
    const item = (date: string) => ({ description: 'Mitteilung "Hausaufgaben" veröffentlicht von Pfalzgraf', date: Date.parse(date) });
    expect(matchInfoMessage(messages, item('2026-11-12T17:41:00+01:00'))?.text).toBe('Lösen Sie Aufgabe 3.');
    expect(matchInfoMessage(messages, item('2026-11-27T08:12:00+01:00'))?.published).toBe('2026-11-26');
    expect(matchInfoMessage(messages, { description: 'Neue Datei', date: 0 })).toBeUndefined();
  });

  it('finds the course node in notification links', () => {
    expect(infoMessageTarget('https://olat.bms-w.ch/url/RepositoryEntry/12648576/CourseNode/114484000378050/InfoMessage/107872277')).toEqual({
      courseId: 12648576,
      nodeId: '114484000378050',
    });
    expect(infoMessageTarget('https://olat.bms-w.ch/url/RepositoryEntry/1')).toBeNull();
  });
});
