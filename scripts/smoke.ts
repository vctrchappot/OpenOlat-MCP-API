/**
 * Live smoke test against OpenOLAT. Needs OLAT_USERNAME/OLAT_PASSWORD (e.g. in .env):
 *   npm run smoke
 * Optional: SMOKE_COURSE=<repositoryEntryId> to pick a course.
 */
import { OlatClient, type CourseTreeNode } from '../src/olat/client.js';

const username = process.env.OLAT_USERNAME ?? process.env.OLAT_USER;
const password = process.env.OLAT_PASSWORD ?? process.env.OLAT_PASS;
if (!username || !password) throw new Error('OLAT_USERNAME/OLAT_PASSWORD fehlen');

const c = new OlatClient({ username, password }, { baseUrl: process.env.OLAT_BASE_URL ?? 'https://olat.bms-w.ch' });
const step = async <T>(name: string, fn: () => Promise<T>, show: (v: T) => string): Promise<T | undefined> => {
  const t = Date.now();
  try {
    const v = await fn();
    console.log(`✓ ${name} (${Date.now() - t} ms): ${show(v)}`);
    return v;
  } catch (e) {
    console.log(`✗ ${name}: ${(e as Error).stack}`);
    process.exitCode = 1;
  }
};
const flat = (ns: CourseTreeNode[]): CourseTreeNode[] => ns.flatMap((n) => [n, ...flat(n.children)]);

const me = await step('whoami', () => c.whoami(), (u) => `${u.firstName} ${u.lastName}`);
const courses = await step('my courses', () => c.listMyCourses(), (l) => l.map((x) => `${x.id}:${x.title}`).join(', '));
await step('search', () => c.searchCourses('Mathematik'), (l) => `${l.length} Treffer`);
const courseId = Number(process.env.SMOKE_COURSE ?? courses?.find((x) => x.type === 'condition')?.id);
await step('course info', () => c.getCourseInfo(courseId), (i) => `${i.title}, ${i.folders.length} Ordner`);
const tree = await step('course tree', () => c.getCourseTree(courseId), (t) => `${flat(t).length} Knoten, Typen: ${[...new Set(flat(t).map((n) => n.type))].join(',')}`);
const nodes = tree ? flat(tree) : [];
const page = nodes.find((n) => n.type === 'page');
if (page) {
  const v = await step(`node page ${page.title}`, () => c.getCourseNode(courseId, page.id), (v) => `opened=${v.opened} md=${v.markdown.length} files=${v.files.map((f) => f.name).join(',')}`);
  if (v?.files.length) await step('read page file', () => c.readFile(courseId, page.id), (r) => `${r.file.filename} ${r.file.size}B ${r.content.kind} ${r.content.kind === 'text' ? r.content.text.slice(0, 80).replace(/\s+/g, ' ') : ''}`);
}
const folderNode = nodes.find((n) => n.type === 'folder');
if (folderNode) {
  const f = await step(`folder ${folderNode.title}`, () => c.listFolder(courseId, folderNode.id), (f) => `${f.entries.length}/${f.total} Einträge: ${f.entries.slice(0, 4).map((e) => e.name).join(', ')}`);
  const sub = f?.entries.find((e) => e.kind === 'folder');
  if (sub) {
    const s = await step(`subfolder ${sub.name}`, () => c.listFolder(courseId, folderNode.id, sub.name), (f) => `${f.entries.length} Einträge`);
    const deep = s?.entries.find((e) => e.kind === 'folder');
    if (deep) await step(`subsubfolder ${deep.name}`, () => c.listFolder(courseId, folderNode.id, `${sub.name}/${deep.name}`), (f) => `${f.entries.length} Einträge: ${f.entries.slice(0, 3).map((e) => e.name).join(', ')}`);
    const nested = s?.entries.find((e) => e.kind === 'file');
    if (nested) await step(`read nested ${nested.name}`, () => c.readFile(courseId, folderNode.id, `${sub.name}/${nested.name}`), (r) => `${r.file.filename} ${r.file.size}B ${r.content.kind}`);
  }
  const file = f?.entries.find((e) => e.kind === 'file' && !/\.pdf$/i.test(e.name)) ?? f?.entries.find((e) => e.kind === 'file');
  if (file) await step(`read ${file.name}`, () => c.readFile(courseId, folderNode.id, file.name), (r) => `${r.file.filename} ${r.file.size}B ${r.content.kind}`);
}
await step('events', () => c.listEvents(new Date(), new Date(Date.now() + 90 * 86_400_000)), (e) => `${e.length} Termine`);
await step('notifications', () => c.notifications(new Date(Date.now() - 30 * 86_400_000)), (n) => `${n.length} Abos mit News`);
await step('groups', () => c.listGroups(), (g) => `${g.length} Gruppen`);
await step('webdav', () => c.listWebDav(''), (e) => e.map((x) => x.name).join(','));
if (me) await step('open page effstatements', () => c.openPage(`/url/HomeSite/${me.key}/effstatements/0`), (p) => `${p.title}: ${p.markdown.slice(0, 120).replace(/\s+/g, ' ')}`);
