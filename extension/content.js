// Läuft auf olat.bms-w.ch. Erkennt das OLAT-Login-Formular und meldet mit den gespeicherten Zugangsdaten an.
// OLAT meldet in zwei Schritten an: erst der Benutzername, dann erscheint (per XHR) das Passwortfeld.
// Wir bedienen deshalb die echte Seite, statt das Formular nachzubauen.
(() => {
  'use strict';
  if (globalThis.__olatAutoLogin) return;
  globalThis.__olatAutoLogin = true;

  const FORM = 'ofo_oolat_login';
  const USER = 'o_fiooolat_login_name';
  const PASS = 'o_fiooolat_login_pass';
  const BUTTON = 'o_fiooolat_login_button';
  const ERROR = `#${FORM} .o_error, #${FORM} .has-error, #${FORM} .alert-danger, .o_login_error`;
  const STEP_TIMEOUT = 10_000;

  const send = (message) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply);
        });
      } catch {
        resolve(undefined);
      }
    });

  const input = (name) => document.querySelector(`#${FORM} input[name="${name}"]`);
  const errorText = () => [...document.querySelectorAll(ERROR)].map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  const hasError = () => Boolean(errorText());

  /** Setzt den Wert so, dass auch die Listener der Seite (input/change) ihn mitbekommen. */
  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Wartet, bis `check()` etwas Wahres liefert (DOM-Änderung) oder die Zeit abgelaufen ist. */
  function waitFor(check, ms = STEP_TIMEOUT) {
    return new Promise((resolve) => {
      const now = check();
      if (now) return resolve(now);
      let timer;
      const done = (value) => {
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        const hit = check();
        if (hit) done(hit);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      timer = setTimeout(() => done(null), ms);
    });
  }

  const click = () => document.getElementById(BUTTON)?.click();

  async function login() {
    const userField = input(USER);
    if (!userField) return;
    const creds = await send({ type: 'getLoginCredentials' });
    if (!creds || !creds.username) return;

    // Hat jemand schon etwas anderes eingetragen (anderes Konto), nichts überschreiben.
    if (userField.value && userField.value !== creds.username) return;
    setValue(userField, creds.username);
    click();

    const passField = await waitFor(() => input(PASS) || (hasError() ? 'error' : null));
    if (passField === 'error') return void (await send({ type: 'loginFailed', step: 'username', message: errorText().slice(0, 200) }));
    if (!passField) return;
    if (passField.value && passField.value !== creds.password) return;
    setValue(passField, creds.password);
    click();

    // Bei Erfolg lädt OLAT eine neue Seite und dieses Skript endet. Bleibt eine Fehlermeldung stehen, sind die Daten falsch.
    if (await waitFor(hasError)) await send({ type: 'loginFailed', step: 'password', message: errorText().slice(0, 200) });
  }

  // Wer sich bewusst abmeldet, soll nicht sofort wieder angemeldet werden.
  document.addEventListener(
    'click',
    (event) => {
      const el = event.target instanceof Element ? event.target.closest('a, button') : null;
      if (!el) return;
      const meta = `${el.id} ${el.className} ${el.getAttribute('href') ?? ''} ${el.getAttribute('onclick') ?? ''}`.toLowerCase();
      if (/logout/.test(meta) || /^\s*(logout|abmelden)\s*$/i.test(el.textContent ?? '')) void send({ type: 'userLoggedOut' });
    },
    true,
  );

  if (document.getElementById(FORM)) void login();
  else {
    // Das Formular kann kurz nach dem Laden erscheinen, etwa bei abgelaufener Sitzung.
    void waitFor(() => document.getElementById(FORM), 5_000).then((form) => form && login());
  }
})();
