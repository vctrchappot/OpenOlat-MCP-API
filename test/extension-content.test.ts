// @vitest-environment jsdom
/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Das Formular stammt aus der echten Login-Seite von olat.bms-w.ch (ohne Inline-Skripte).
const FORM = readFileSync(join(process.cwd(), 'test/fixtures/olat-login-form.html'), 'utf8');
const SOURCE = readFileSync(join(process.cwd(), 'extension/content.js'), 'utf8');

type Message = { type: string; step?: string; message?: string };
type Reply = { username: string; password: string } | { skip: string } | { ok: true };

let sent: Message[];
let reply: (m: Message) => Reply;
let clicks: number;
let serverAnswer: 'ok' | 'badUser' | 'badPassword';

/** Spielt die Gegenseite: Der erste Klick lädt (wie OLAT per XHR) das Passwortfeld, der zweite prüft das Passwort. */
function fakeOlat() {
  const button = document.getElementById('o_fiooolat_login_button')!;
  button.addEventListener('click', () => {
    clicks++;
    setTimeout(() => {
      const form = document.getElementById('ofo_oolat_login')!;
      if (clicks === 1) {
        if (serverAnswer === 'badUser') form.insertAdjacentHTML('afterbegin', '<div class="o_error">Unbekannter Benutzer</div>');
        else document.getElementById('o_cooolat_login_pass')!.innerHTML = '<input type="password" name="o_fiooolat_login_pass">';
      } else if (serverAnswer === 'badPassword') {
        form.insertAdjacentHTML('afterbegin', '<div class="o_error">Falsches Passwort</div>');
      }
    }, 5);
  });
}

function runContentScript() {
  delete (globalThis as { __olatAutoLogin?: boolean }).__olatAutoLogin;
  (0, eval)(SOURCE);
}

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  sent = [];
  clicks = 0;
  serverAnswer = 'ok';
  reply = (m) => (m.type === 'getLoginCredentials' ? { username: 'max.muster', password: 'Geheim-123!' } : { ok: true });
  (globalThis as any).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (m: Message, cb: (r: Reply) => void) => {
        sent.push(m);
        cb(reply(m));
      },
    },
  };
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('content script', () => {
  it('logs in through both steps of the OLAT form', async () => {
    document.body.innerHTML = FORM;
    fakeOlat();
    runContentScript();
    await tick();

    expect((document.querySelector('input[name="o_fiooolat_login_name"]') as HTMLInputElement).value).toBe('max.muster');
    expect((document.querySelector('input[name="o_fiooolat_login_pass"]') as HTMLInputElement).value).toBe('Geheim-123!');
    expect(clicks).toBe(2);
    expect(sent.map((m) => m.type)).toEqual(['getLoginCredentials']);
  });

  it('reports a rejected user name and stops', async () => {
    document.body.innerHTML = FORM;
    serverAnswer = 'badUser';
    fakeOlat();
    runContentScript();
    await tick();

    expect(clicks).toBe(1);
    expect(sent).toContainEqual({ type: 'loginFailed', step: 'username', message: 'Unbekannter Benutzer' });
  });

  it('reports a rejected password', async () => {
    document.body.innerHTML = FORM;
    serverAnswer = 'badPassword';
    fakeOlat();
    runContentScript();
    await tick(150);

    expect(sent).toContainEqual({ type: 'loginFailed', step: 'password', message: 'Falsches Passwort' });
  });

  it('does nothing without credentials or when paused', async () => {
    document.body.innerHTML = FORM;
    reply = () => ({ skip: 'paused' });
    fakeOlat();
    runContentScript();
    await tick();

    expect(clicks).toBe(0);
    expect((document.querySelector('input[name="o_fiooolat_login_name"]') as HTMLInputElement).value).toBe('');
  });

  it('does not overwrite another account the user already typed', async () => {
    document.body.innerHTML = FORM;
    (document.querySelector('input[name="o_fiooolat_login_name"]') as HTMLInputElement).value = 'anderes.konto';
    fakeOlat();
    runContentScript();
    await tick();

    expect(clicks).toBe(0);
    expect((document.querySelector('input[name="o_fiooolat_login_name"]') as HTMLInputElement).value).toBe('anderes.konto');
  });

  it('stays silent on pages without a login form', async () => {
    document.body.innerHTML = '<main><h1>Meine Kurse</h1></main>';
    runContentScript();
    await tick();
    expect(sent).toEqual([]);
  });

  it('remembers an explicit logout', async () => {
    document.body.innerHTML = '<a id="out" href="/dmz/?logout=1">Logout</a>';
    runContentScript();
    document.getElementById('out')!.addEventListener('click', (e) => e.preventDefault());
    document.getElementById('out')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(sent).toContainEqual({ type: 'userLoggedOut' });
  });
});
