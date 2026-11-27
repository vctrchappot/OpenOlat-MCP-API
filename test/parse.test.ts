import { describe, expect, it } from 'vitest';
import { folderPathSegment, normalizeFolderPath, toAuthPath } from '../src/olat/client.js';
import { commandHtml, commandRedirect, parseCommandResponse } from '../src/olat/commands.js';
import { htmlToMarkdown } from '../src/olat/markdown.js';
import { parseCourseTree, parseFolder, parseNodeContent, parseViewerFile } from '../src/olat/parse.js';

const toggle = (id: string) =>
  `<a href="javascript:;" onclick="o_XHREvent('/auth/1:1:5:2:1/',false,true,'cid','ctncl','nidle','${id}','ctntr','open','_csrf','c'); return false;" class="o_tree_open_close"></a>`;
const item = (id: string, icon: string, title: string, inner = '', open = false, cls = '') =>
  `<li class="${cls}" data-nodeid="${id}"><div>${open ? '' : inner ? '' : ''}${!open && inner === 'closed' ? toggle(id) : ''}<span class="o_tree_link"><a href="javascript:;"><i class="o_icon o_icon-fw ${icon}"></i> <span class="o_tree_item">${title}</span></a></span></div>${open ? `<ul>${inner}</ul>` : ''}</li>`;

const TREE = `<div class="o_tree o_course_menu"><ul role="tree">${item(
  '1',
  'o_CourseModule_icon',
  'Kurs',
  item('2', 'o_st_icon', 'Kapitel A', item('3', 'o_sp_icon', 'Skript') + item('4', 'o_bc_icon', 'Ordner'), true) + item('5', 'o_st_icon', 'Kapitel B', 'closed') + item('6', 'o_icon o_filetype_file o_filetype_xlsx', 'Tabelle', '', false, 'o_lp_status o_lp_done'),
  true,
)}</ul></div>`;

describe('parseCourseTree', () => {
  const nodes = parseCourseTree(TREE);
  it('reads ids, parents, types', () => {
    expect(nodes.map((n) => [n.id, n.parentId, n.type])).toEqual([
      ['1', null, 'course'],
      ['2', '1', 'structure'],
      ['3', '2', 'page'],
      ['4', '2', 'folder'],
      ['5', '1', 'structure'],
      ['6', '1', 'document'],
    ]);
  });
  it('detects collapsed nodes with expand events', () => {
    const b = nodes.find((n) => n.id === '5')!;
    expect(b.hasChildren).toBe(true);
    expect(b.expanded).toBe(false);
    expect(b.expand).toMatchObject({ kind: 'component', params: { cid: 'ctncl', nidle: '5', ctntr: 'open' } });
    expect(nodes.find((n) => n.id === '2')!.expanded).toBe(true);
  });
  it('reads learning path status', () => {
    expect(nodes.find((n) => n.id === '6')!.status).toBe('done');
  });
  it('parses AJAX redraws without the menu wrapper', () => {
    expect(parseCourseTree(TREE.replace('o_course_menu', ''))).toHaveLength(6);
  });
});

describe('commands', () => {
  it('parses JSON responses', () => {
    const r = parseCommandResponse(JSON.stringify({ cmds: [{ cmd: 5, cda: { rurl: '/m/abc/' } }] }))!;
    expect(commandRedirect(r)).toBe('/m/abc/');
  });
  it('parses HTML-wrapped responses', () => {
    const payload = { cmds: [{ cmd: 2, cda: { cps: [{ hfrag: '<p>a "quoted" {brace}</p>' }, { hfrag: '<p>b</p>' }] } }] };
    const r = parseCommandResponse(`<html><head><script>function invoke(){var r=${JSON.stringify(payload)}; o_ainvoke(r);}</script></head></html>`)!;
    expect(commandHtml(r)).toBe('<p>a "quoted" {brace}</p>\n<p>b</p>');
  });
  it('returns null for normal pages', () => {
    expect(parseCommandResponse('<html><body>hi</body></html>')).toBeNull();
  });
});

describe('parseNodeContent', () => {
  const html = `<html><head><title>Kurs - Skript</title></head><body><div id="o_main_center_content_inner">
    <div class="o_toolbar">Toolbar</div>
    <h2>Skript</h2><p>Lies <a href="https://example.org/x">das hier</a> und <a href="/auth/1:1:22:3:1/Seite">Wiki</a>.</p>
    <a class="o_download" href="javascript:;" onclick="o_XHREvent('/auth/3:1:9:2:1/',true,true,'cid','command.download','_csrf','c'); return false;">Download</a>
    <iframe src="/raw/x/js/pdfjs/web/viewer.html?file=%2Fm%2Fabc%2FSkript.pdf"></iframe>
    <script>alert(1)</script></div></body></html>`;
  const c = parseNodeContent(html, 'https://olat.example.ch/auth/RepositoryEntry/1/CourseNode/2');
  it('extracts text without chrome and scripts', () => {
    expect(c.markdown).toContain('## Skript');
    expect(c.markdown).toContain('[das hier](https://example.org/x)');
    expect(c.markdown).not.toContain('Toolbar');
    expect(c.markdown).not.toContain('alert');
  });
  it('drops in-window event links', () => {
    expect(c.links.map((l) => l.url)).toEqual(['https://example.org/x']);
  });
  it('resolves pdf viewer embeds and the download button', () => {
    expect(c.embeds).toEqual([{ name: 'Skript.pdf', url: 'https://olat.example.ch/m/abc/Skript.pdf' }]);
    expect(c.download).toMatchObject({ params: { cid: 'command.download' } });
    expect(c.isFolder).toBe(false);
  });
});

describe('parseFolder', () => {
  const row = (attr: string, name: string, by: string, type: string, size: string, idx: number) =>
    `<tr class="o_folder_row" ${attr}="${name}"><td><input type="checkbox"></td><td></td><td><a><span>${name}</span></a></td>
     <td><a href="javascript:;" onclick="o_ffXHREvent('ofo_1','ofo_1_dispatchuri','o_fi5','ofo_1_eventval','2',true,true,false,true,'download','${idx}'); return false;"><i class="o_icon o_icon_download"></i></a></td>
     <td>${by}</td><td>${type}</td><td>${size}</td><td></td><td></td></tr>`;
  const html = `<form id="ofo_1"><table><thead><tr><th class="o_multiselect"></th><th class=" o_col_icon"></th><th class=" o_col_title"></th><th class=" o_col_download"></th><th></th><th></th><th></th><th></th><th></th></tr></thead><tbody>
    ${row('data-upload-folder', 'Kapitel 1', '', 'Ordner', '3 Element(e)', 0)}${row('data-drag-file', 'blatt.pdf', 'Muster, Max', 'pdf', '12 kB', 1)}
  </tbody></table></form><div>2 Einträge</div>`;
  const f = parseFolder(html);
  it('lists entries with metadata', () => {
    expect(f.entries.map(({ download: _d, ...e }) => e)).toEqual([
      { name: 'Kapitel 1', kind: 'folder', createdBy: '', type: 'Ordner', size: '3 Element(e)' },
      { name: 'blatt.pdf', kind: 'file', createdBy: 'Muster, Max', type: 'pdf', size: '12 kB' },
    ]);
    expect(f.total).toBe(2);
    expect(f.truncated).toBe(false);
  });
  it('keeps the row download event', () => {
    expect(f.entries[1].download).toEqual({ kind: 'form', formName: 'ofo_1', dispatchUri: 'o_fi5', dispatchEvent: '2', params: { download: '1' } });
  });
});

describe('parseViewerFile', () => {
  it('finds the file behind the pdf viewer', () => {
    const html = `<div class="modal"><iframe src="/raw/x/js/pdfjs/web/viewer.html?file=/m/02f3"></iframe></div>`;
    expect(parseViewerFile(html, 'https://olat.example.ch/auth/x')).toBe('https://olat.example.ch/m/02f3');
  });
});

describe('htmlToMarkdown', () => {
  it('renders lists, tables and emphasis', () => {
    const { markdown } = htmlToMarkdown('<h3>T</h3><ul><li>a</li><li><b>b</b></li></ul><table><tr><th>x</th><th>y</th></tr><tr><td>1</td><td>2|3</td></tr></table>');
    expect(markdown).toBe('### T\n\n- a\n- **b**\n\n| x | y |\n| --- | --- |\n| 1 | 2\\|3 |');
  });
});

describe('paths', () => {
  it('encodes nested folder paths like OpenOLAT', () => {
    expect(folderPathSegment('')).toBe('');
    expect(folderPathSegment('/A b/C/')).toBe('/path%3D~~A%20b~~C/0');
  });
  it('rejects parent traversal', () => {
    expect(() => normalizeFolderPath('a/../b')).toThrow();
  });
  it('maps public URLs to authenticated business paths', () => {
    const base = new URL('https://olat.example.ch');
    expect(toAuthPath('https://olat.example.ch/url/RepositoryEntry/1/CourseNode/2', base)).toBe('/auth/RepositoryEntry/1/CourseNode/2');
    expect(toAuthPath('HomeSite/5/effstatements/0', base)).toBe('/auth/HomeSite/5/effstatements/0');
    expect(() => toAuthPath('https://evil.example/url/x', base)).toThrow();
  });
});
