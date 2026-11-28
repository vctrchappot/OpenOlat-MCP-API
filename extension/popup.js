import { OLAT_ORIGIN } from './store.js';

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

function ago(ts) {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  return `vor ${Math.round(minutes / 60)} Std.`;
}

function describe(s) {
  const { state, settings } = s;
  if (state.authError) {
    const reason = state.authError.message ? ` OLAT meldet: «${state.authError.message}»` : '';
    return ['bad', `Anmeldung fehlgeschlagen.${reason} Zugangsdaten prüfen, speichern oder «Auto-Login wieder aktivieren».`];
  }
  if (!s.hasCredentials) return ['warn', 'Noch keine Zugangsdaten gespeichert.'];
  if (s.pausedUntil > Date.now()) return ['warn', 'Auto-Login pausiert (du hast dich abgemeldet).'];
  if (!settings.autoLogin) return ['warn', 'Auto-Login ist ausgeschaltet.'];
  if (state.lastPingResult === 'ok') return ['ok', `Sitzung aktiv (geprüft ${ago(state.lastPing)}).`];
  if (state.lastPingResult === 'loggedOut') return ['warn', `Nicht angemeldet (geprüft ${ago(state.lastPing)}). Beim nächsten Öffnen von OLAT wird angemeldet.`];
  return ['ok', 'Bereit. Beim nächsten Öffnen von OLAT wird automatisch angemeldet.'];
}

function render(s) {
  const [kind, text] = describe(s);
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
  $('resume').hidden = !(s.state.authError || s.pausedUntil > Date.now());
  $('clear').hidden = !s.hasCredentials;
  // Der Status kommt asynchron: Was gerade getippt wird, darf nicht überschrieben werden.
  if (!$('u').dataset.dirty) $('u').value = s.username;
  if (!$('p').dataset.dirty) $('p').value = '';
  $('p').placeholder = s.hasCredentials ? 'gespeichert – zum Ändern neu eingeben' : '';
  for (const box of document.querySelectorAll('[data-setting]')) box.checked = Boolean(s.settings[box.dataset.setting]);
}

async function refresh() {
  render(await send({ type: 'status' }));
}

for (const id of ['u', 'p']) $(id).addEventListener('input', () => ($(id).dataset.dirty = '1'));

$('creds').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('u').value;
  let password = $('p').value;
  if (!password) {
    $('msg').textContent = 'Bitte das Passwort eingeben.';
    return;
  }
  const result = await send({ type: 'saveCredentials', username, password });
  password = '';
  delete $('u').dataset.dirty;
  delete $('p').dataset.dirty;
  if (result.error) {
    $('msg').textContent = result.error;
    return;
  }
  $('msg').textContent = 'Gespeichert. Beim nächsten Öffnen von OLAT wird angemeldet.';
  render(result);
});

$('clear').addEventListener('click', async () => {
  render(await send({ type: 'clearCredentials' }));
  $('msg').textContent = 'Zugangsdaten gelöscht.';
});

$('resume').addEventListener('click', async () => render(await send({ type: 'resume' })));

for (const box of document.querySelectorAll('[data-setting]')) {
  box.addEventListener('change', async () => render(await send({ type: 'saveSettings', settings: { [box.dataset.setting]: box.checked } })));
}

$('open').addEventListener('click', () => chrome.tabs.create({ url: `${OLAT_ORIGIN}/auth/` }));

refresh();
