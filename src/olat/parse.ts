import * as cheerio from 'cheerio';
import { parseEvent, type OlatEvent } from './events.js';
import { htmlToMarkdown, type LinkRef } from './markdown.js';

const NODE_TYPES: Record<string, string> = {
  o_CourseModule_icon: 'course',
  o_st_icon: 'structure',
  o_sp_icon: 'page',
  o_bc_icon: 'folder',
  o_pf_icon: 'participant-folder',
  o_fo_icon: 'forum',
  o_wiki_icon: 'wiki',
  o_blog_icon: 'blog',
  o_podcast_icon: 'podcast',
  o_iqtest_icon: 'test',
  o_iqself_icon: 'self-test',
  o_iqsurv_icon: 'survey',
  o_survey_icon: 'survey',
  o_infomsg_icon: 'info-messages',
  o_tu_icon: 'external-page',
  o_ll_icon: 'link-list',
  o_cal_icon: 'calendar',
  o_co_icon: 'contact-form',
  o_en_icon: 'enrollment',
  o_ta_icon: 'task',
  o_gta_icon: 'task',
  o_ms_icon: 'assessment',
  o_cp_icon: 'content-package',
  o_scorm_icon: 'scorm',
  o_video_icon: 'video',
  o_cl_icon: 'checklist',
  o_dialog_icon: 'file-dialog',
  o_document_icon: 'document',
  o_page_icon: 'page',
  o_vc_icon: 'virtual-classroom',
  o_bigbluebutton_icon: 'bigbluebutton',
  o_teams_icon: 'teams',
  o_zoom_icon: 'zoom',
  o_cns_icon: 'learning-path-selection',
  o_gtask_icon: 'task',
};

export interface TreeNode {
  id: string;
  parentId: string | null;
  title: string;
  /** Node type derived from the icon (empty for learning-path courses, which render no icons). */
  type: string;
  hasChildren: boolean;
  expanded: boolean;
  /** Learning-path status (e.g. `done`, `ready`, `notaccessible`) if present. */
  status?: string;
  /** Event to expand the node without opening it. */
  expand?: OlatEvent;
}

export function parseCourseTree(html: string): TreeNode[] {
  const $ = cheerio.load(html);
  const out: TreeNode[] = [];
  let items = $('.o_course_menu li[data-nodeid]');
  // AJAX redraws of the menu contain the tree without the surrounding `.o_course_menu`.
  if (!items.length) items = $('ul[role="tree"] li[data-nodeid]');
  items.each((_, e) => {
    const li = $(e);
    const div = li.children('div').first();
    const iconClasses = (div.find('i.o_icon-fw').first().attr('class') ?? '').split(/\s+/);
    const iconClass = iconClasses.find((c) => c in NODE_TYPES) ?? (iconClasses.some((c) => c.startsWith('o_filetype_')) ? 'o_document_icon' : undefined);
    const toggle = div.find('a.o_tree_open_close').first();
    const childList = li.children('ul');
    const status = (li.attr('class') ?? '')
      .split(/\s+/)
      .filter((c) => /^o_lp_(done|ready|notaccessible|inprogress|not_in_sequence|optional|in_progress)$/.test(c))
      .map((c) => c.replace(/^o_lp_/, ''))[0];
    const titleEl = div.find('.o_tree_item').first();
    out.push({
      id: li.attr('data-nodeid')!,
      parentId: li.parent().closest('li[data-nodeid]').attr('data-nodeid') ?? null,
      title: titleEl.text().trim(),
      type: iconClass ? NODE_TYPES[iconClass] : '',
      hasChildren: toggle.length > 0 || childList.children('li').length > 0,
      expanded: childList.children('li').length > 0,
      status,
      expand: parseEvent(toggle.attr('onclick')) ?? undefined,
    });
  });
  return out;
}

export interface FileRef {
  name: string;
  /** Session-bound URL. Valid only for a short time; use the node/path locator to re-fetch. */
  url: string;
}

export interface NodeContent {
  title: string;
  markdown: string;
  links: LinkRef[];
  /** Embedded documents (iframes) and downloadable mapper resources. */
  embeds: FileRef[];
  /** True if the node renders a folder (use `parseFolder`). */
  isFolder: boolean;
  /** "Herunterladen" button of the node (document nodes, single pages). */
  download?: OlatEvent;
}

/** Removes UI chrome (toolbars, menus, hidden dialogs) from the main content area. */
function stripChrome($: cheerio.CheerioAPI, root: cheerio.Cheerio<any>) {
  root
    .find(
      [
        'script',
        'style',
        '.o_toolbar',
        '.o_button_group',
        '.dropdown-menu',
        '.o_table_toolbar',
        '.o_table_tools',
        '.o_table_batch_buttons',
        '.o_breadcrumb_bar_tools',
        '.o_course_pagination',
        '.o_navbar',
        '.modal',
        '.o_sel_course_node_navigation',
        '.o_icon_actions',
        '.sr-only',
        '.o_course_run_toolbar',
        '.o_scorm_navigation',
      ].join(','),
    )
    .remove();
}

export function mainContent(html: string): cheerio.Cheerio<any> | null {
  const $ = cheerio.load(html);
  const main = $('#o_main_center_content_inner').first();
  return main.length ? main : null;
}

export function parseNodeContent(html: string, pageUrl: string): NodeContent {
  const $ = cheerio.load(html);
  const main = $('#o_main_center_content_inner').first();
  const root = main.length ? main : $('#o_main_container, body').first();
  const isFolder = root.find('tr.o_folder_row').length > 0 || root.find('.o_folder_table, .o_folder').length > 0;

  const embeds: FileRef[] = [];
  root.find('iframe[src]').each((_, e) => {
    let src = $(e).attr('src')!;
    const viewer = src.match(/[?&]file=([^&]+)/);
    if (viewer) src = decodeURIComponent(viewer[1]);
    const url = new URL(src, pageUrl).href;
    embeds.push({ name: decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Inhalt'), url });
  });
  root.find('a[href^="/m/"], video source[src^="/m/"], video[src^="/m/"], audio[src^="/m/"]').each((_, e) => {
    const src = $(e).attr('href') ?? $(e).attr('src')!;
    if (/\.css$|courseCSS/.test(src)) return;
    const url = new URL(src, pageUrl).href;
    if (!embeds.some((f) => f.url === url)) embeds.push({ name: $(e).text().trim() || decodeURIComponent(url.split('/').pop() || 'Datei'), url });
  });

  let download: OlatEvent | undefined;
  root.find('a').each((_, e) => {
    const ev = parseEvent($(e).attr('onclick'));
    if (!download && ev?.kind === 'component' && /^(run|command)\.download$/.test(ev.params.cid ?? '')) download = ev;
  });

  stripChrome($, root);
  const title = $('title').first().text().trim();
  const { markdown, links } = htmlToMarkdown($.html(root), pageUrl);
  return { title, markdown, links, embeds, isFolder, download };
}

export interface FolderEntry {
  name: string;
  kind: 'folder' | 'file';
  type: string;
  size: string;
  createdBy: string;
  modified?: string;
  /** Row download event (works for files and folders – folders are zipped). */
  download?: OlatEvent;
}

export interface FolderListing {
  /** Breadcrumb inside the folder node, e.g. ["Lektions-Notizen", "01_Arithmetik"]. */
  breadcrumb: string[];
  total?: number;
  entries: FolderEntry[];
  /** True if OpenOLAT paginated the table and not all entries are listed. */
  truncated: boolean;
}

export function parseFolder(html: string): FolderListing {
  const $ = cheerio.load(html);
  const table = $('tr.o_folder_row').first().closest('table');
  const headers = table
    .find('thead th')
    .toArray()
    .map((th) => ($(th).attr('class') ?? '').split(/\s+/).find((c) => c.startsWith('o_col_')) ?? '');
  const col = (name: string) => headers.indexOf(name);
  const entries: FolderEntry[] = [];
  table.find('tbody tr.o_folder_row').each((_, e) => {
    const tr = $(e);
    const cells = tr.children('td');
    const folderName = tr.attr('data-upload-folder');
    const fileName = tr.attr('data-drag-file');
    const name = folderName ?? fileName ?? cells.eq(col('o_col_title')).text().trim();
    const text = (i: number) => (i >= 0 ? cells.eq(i).text().replace(/\s+/g, ' ').trim() : '');
    // Column order without dedicated classes: [check, icon, title, download, createdBy, type, size, status, actions]
    const titleIdx = col('o_col_title');
    entries.push({
      name,
      kind: folderName !== undefined ? 'folder' : 'file',
      createdBy: text(titleIdx + 2),
      type: text(titleIdx + 3),
      size: text(titleIdx + 4),
      download: parseEvent(tr.find('i.o_icon_download').first().closest('a').attr('onclick')) ?? undefined,
    });
  });
  const crumbs = $('.o_breadcrumb li, .o_folder_breadcrumb a, ol.breadcrumb li')
    .toArray()
    .map((li) => $(li).text().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const countText = $('.o_table_count, .o_table_rows_infos').first().text();
  const totalMatch = (countText || $.root().text()).match(/(\d+)\s+Einträge?/);
  const total = totalMatch ? Number(totalMatch[1]) : undefined;
  const truncated = $('.o_table_pagination, ul.pagination').length > 0 || (total !== undefined && total > entries.length);
  return { breadcrumb: [...new Set(crumbs)], total, entries, truncated };
}

/** Finds the session-bound file URL opened by a folder's file viewer (`…/path=file.pdf`). */
export function parseViewerFile(html: string, pageUrl: string): string | null {
  const $ = cheerio.load(html);
  for (const el of $('.modal iframe[src], .o_lightbox iframe[src], iframe[src*="viewer.html"], .modal video source[src], .modal img[src^="/m/"]').toArray()) {
    const src = $(el).attr('src')!;
    const m = src.match(/[?&]file=([^&]+)/);
    return new URL(m ? decodeURIComponent(m[1]) : src, pageUrl).href;
  }
  return null;
}
