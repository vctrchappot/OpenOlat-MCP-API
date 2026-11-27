import { describe, expect, it } from 'vitest';
import { ReadOnlyViolation } from '../src/olat/errors.js';
import { assertReadOnlyEvent, parseEvent, parseJsArgs } from '../src/olat/events.js';
import { assertSafeGet } from '../src/olat/web.js';

const base = new URL('https://olat.example.ch');

describe('parseJsArgs', () => {
  it('parses strings, booleans and numbers', () => {
    expect(parseJsArgs(`'/auth/1:1:2:2:1/',false,true,'cid','ctncl', 42, null`)).toEqual(['/auth/1:1:2:2:1/', false, true, 'cid', 'ctncl', 42, null]);
  });
  it('handles escaped quotes and commas inside strings', () => {
    expect(parseJsArgs(`'it\\'s, ok',"a,b"`)).toEqual(["it's, ok", 'a,b']);
  });
});

describe('parseEvent', () => {
  it('parses component events', () => {
    const ev = parseEvent(
      `o_XHREvent('/auth/1:1:1002186371:2:1/',false,true,'cid','ctncl','nidle','101937276160127','ctntr','open','_csrf','abc'); return false;`,
    );
    expect(ev).toEqual({ kind: 'component', url: '/auth/1:1:1002186371:2:1/', params: { cid: 'ctncl', nidle: '101937276160127', ctntr: 'open', _csrf: 'abc' } });
  });
  it('parses flexi form events', () => {
    const ev = parseEvent(`o_ffXHREvent('ofo_1','ofo_1_dispatchuri','o_fi9','ofo_1_eventval','2',true,true,false,true,'download','3'); return false;`);
    expect(ev).toEqual({ kind: 'form', formName: 'ofo_1', dispatchUri: 'o_fi9', dispatchEvent: '2', params: { download: '3' } });
  });
  it('returns null for unknown handlers', () => {
    expect(parseEvent(`o_ffEvent(event,'ofo_1','x','y','z','2');`)).toBeNull();
    expect(parseEvent(undefined)).toBeNull();
  });
});

describe('assertReadOnlyEvent', () => {
  const comp = (params: Record<string, string>) => ({ kind: 'component' as const, url: '/auth/1:1:2:2:1/', params: { ...params, _csrf: 'x' } });
  const form = (params: Record<string, string>) => ({ kind: 'form' as const, formName: 'f', dispatchUri: 'o_fi1', dispatchEvent: '2', params });

  it('allows tree expansion and downloads', () => {
    expect(() => assertReadOnlyEvent(comp({ cid: 'ctncl', nidle: '123', ctntr: 'open' }))).not.toThrow();
    expect(() => assertReadOnlyEvent(comp({ cid: 'run.download' }))).not.toThrow();
    expect(() => assertReadOnlyEvent(comp({ cid: 'command.download' }))).not.toThrow();
    expect(() => assertReadOnlyEvent(form({ download: '7' }))).not.toThrow();
  });

  it.each([
    comp({ cid: 'subscribe' }),
    comp({ cid: 'logout' }),
    comp({ cid: 'ctncl', nidle: '123' }), // would open (visit) the node
    comp({ cid: 'ctncl', nidle: '123', ctntr: 'open', extra: '1' }),
    comp({ cid: 'run.download', delete: '1' }),
    form({}),
    form({ delete: '3' }),
    form({ download: '3', rename: 'x' }),
    form({ download: 'all' }),
  ])('blocks %j', (ev) => {
    expect(() => assertReadOnlyEvent(ev)).toThrow(ReadOnlyViolation);
  });
});

describe('assertSafeGet', () => {
  it.each(['/auth/RepositoryEntry/1/CourseNode/2', '/url/HomeSite/1/effstatements/0', '/m/abc/file.pdf', '/raw/x/js/a.js', '/dmz/', '/auth/'])('allows %s', (p) => {
    expect(() => assertSafeGet(new URL(p, base), base)).not.toThrow();
  });
  it.each(['/auth/1%3A1%3A1002186292%3A2%3A0%3Acid%3Alogout/', '/auth/1:1:2:2:1/', '/restapi/users/me', '/webdav/home/'])('blocks %s', (p) => {
    expect(() => assertSafeGet(new URL(p, base), base)).toThrow(ReadOnlyViolation);
  });
  it('blocks other origins', () => {
    expect(() => assertSafeGet(new URL('https://evil.example/auth/RepositoryEntry/1'), base)).toThrow(ReadOnlyViolation);
  });
});
