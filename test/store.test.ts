import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractOfficeText } from '../src/olat/office.js';
import { CredentialStore } from '../src/store/credentials.js';
import { StatelessTokenStore } from '../src/store/stateless.js';

describe('CredentialStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olat-store-'));
  const store = new CredentialStore(dir);
  const { token } = store.create({ username: 'max.muster', password: 'Geheim-123!' }, 'test');

  it('resolves the token to the credentials', () => {
    expect(token).toMatch(/^olat_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(store.resolve(token)?.creds).toEqual({ username: 'max.muster', password: 'Geheim-123!' });
  });

  it('never writes the password or token to disk', () => {
    const raw = readFileSync(join(dir, 'credentials.json'), 'utf8');
    expect(raw).not.toContain('Geheim-123!');
    expect(raw).not.toContain(token.split('_')[2]);
  });

  it('rejects unknown or tampered tokens', () => {
    expect(store.resolve('olat_0000000000000000_' + 'a'.repeat(43))).toBeNull();
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(store.resolve(tampered)).toBeNull();
    expect(store.resolve('nonsense')).toBeNull();
  });

  it('cannot decrypt with another server secret', () => {
    const other = new CredentialStore(dir, 'different-secret');
    expect(() => other.resolve(token)).toThrow();
  });

  it('persists across instances and revokes', () => {
    const again = new CredentialStore(dir);
    expect(again.resolve(token)?.creds.username).toBe('max.muster');
    expect(again.revoke(token)).toBe(1);
    expect(new CredentialStore(dir).resolve(token)).toBeNull();
  });
});

describe('extractOfficeText', () => {
  it('reads docx paragraphs', () => {
    const doc = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hallo</w:t></w:r><w:r><w:t xml:space="preserve"> Welt</w:t></w:r></w:p><w:p><w:r><w:t>Zeile 2</w:t></w:r></w:p></w:body></w:document>`;
    const zip = Buffer.from(zipSync({ 'word/document.xml': strToU8(doc) }));
    expect(extractOfficeText('a.docx', zip)).toBe('Hallo Welt\nZeile 2');
  });
  it('reads xlsx cells with shared strings', () => {
    const files = {
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Name</t></si><si><t>Note</t></si><si><t>Anna</t></si></sst>'),
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Noten"/></sheets></workbook>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row><c r="A2" t="s"><v>2</v></c><c r="C2"><v>5.5</v></c></row></sheetData></worksheet>'),
    };
    expect(extractOfficeText('n.xlsx', Buffer.from(zipSync(files)))).toBe('--- Tabelle Noten ---\nName\tNote\nAnna\t\t5.5');
  });
  it('ignores other formats', () => {
    expect(extractOfficeText('a.pdf', Buffer.from('x'))).toBeNull();
  });
});

describe('StatelessTokenStore', () => {
  const secret = 'x'.repeat(40);
  const store = new StatelessTokenStore(secret);
  const { token } = store.create({ username: 'max.muster', password: 'Geheim-123!' }, 'vercel');

  it('round-trips credentials without any storage', () => {
    expect(token).toMatch(/^olat_s1_[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('Geheim');
    expect(new StatelessTokenStore(secret).resolve(token)?.creds).toEqual({ username: 'max.muster', password: 'Geheim-123!' });
    expect(store.listForToken(token)[0]).toMatchObject({ username: 'max.muster', label: 'vercel' });
  });

  it('rejects tampered tokens, other secrets and foreign formats', () => {
    expect(store.resolve(token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA'))).toBeNull();
    expect(new StatelessTokenStore('y'.repeat(40)).resolve(token)).toBeNull();
    expect(store.resolve('nonsense')).toBeNull();
    expect(store.resolve('olat_s1_')).toBeNull();
  });

  it('requires a strong server secret and cannot revoke', () => {
    expect(() => new StatelessTokenStore(undefined)).toThrow(/OLAT_MCP_SECRET/);
    expect(() => new StatelessTokenStore('short')).toThrow();
    expect(store.revocable).toBe(false);
  });
});
