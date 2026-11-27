const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Setup page where users deposit their OpenOLAT credentials and receive an API token. */
export function registerPage(publicUrl: string, olatHost: string): string {
  const url = esc(publicUrl.replace(/\/$/, ''));
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OLAT MCP Zugang</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#5b6470; --line:#d9dde3; --accent:#0b5cad; --ok:#0f7b3f; --err:#b42318; --code:#eef1f5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1a1f25; --fg:#e7eaee; --muted:#9aa4b1; --line:#2c333c; --accent:#6aa9ff; --ok:#4cc38a; --err:#ff7b72; --code:#232a32; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 40px 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  p.lead { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  label { display:block; font-weight:600; margin: 12px 0 4px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font-size:1rem; }
  button { margin-top:16px; padding:10px 16px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-weight:600; font-size:1rem; cursor:pointer; }
  button:disabled { opacity:.6; cursor:wait; }
  pre { background: var(--code); padding: 12px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; font-size: .85rem; }
  .err { color: var(--err); } .ok { color: var(--ok); }
  .muted { color: var(--muted); font-size: .9rem; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1>OpenOLAT MCP – Zugang einrichten</h1>
  <p class="lead">Hinterlege deine Anmeldedaten für <strong>${esc(olatHost)}</strong>. Du erhältst ein persönliches Token, mit dem die API bzw. dein KI-Agent <strong>nur lesend</strong> auf deine OpenOLAT-Inhalte zugreift.</p>

  <form class="card" id="f">
    <label for="u">OpenOLAT-Benutzername</label>
    <input id="u" name="username" autocomplete="username" required>
    <label for="p">Passwort</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <label for="l">Bezeichnung (optional)</label>
    <input id="l" name="label" placeholder="z.B. Laptop / Claude Code">
    <button id="b" type="submit">Token erstellen</button>
    <p id="msg" role="status"></p>
    <p class="muted">Das Passwort wird verschlüsselt gespeichert und kann nur mit deinem Token entschlüsselt werden. Das Token wird nur einmal angezeigt.</p>
  </form>

  <section class="card" id="out" hidden>
    <h2 class="ok" style="margin-top:0">Token erstellt</h2>
    <p>Angemeldet als <strong id="who"></strong>. Dein Token:</p>
    <pre id="tok"></pre>
    <p><strong>Claude Code</strong></p>
    <pre id="cc"></pre>
    <p><strong>MCP-Client (JSON-Konfiguration)</strong></p>
    <pre id="js"></pre>
    <p><strong>REST-API</strong></p>
    <pre id="rest"></pre>
    <p class="muted">Token widerrufen: <code>DELETE ${url}/api/tokens</code> mit demselben Authorization-Header.</p>
  </section>
</main>
<script>
const f = document.getElementById('f'), b = document.getElementById('b'), msg = document.getElementById('msg');
f.addEventListener('submit', async (e) => {
  e.preventDefault(); b.disabled = true; msg.textContent = 'Prüfe Anmeldedaten …'; msg.className = '';
  try {
    const res = await fetch('${url}/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(f))) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || res.statusText);
    f.hidden = true; document.getElementById('out').hidden = false;
    document.getElementById('who').textContent = data.user.name;
    document.getElementById('tok').textContent = data.token;
    document.getElementById('cc').textContent = 'claude mcp add --transport http olat ${url}/mcp --header "Authorization: Bearer ' + data.token + '"';
    document.getElementById('js').textContent = JSON.stringify({ mcpServers: { olat: { type: 'http', url: '${url}/mcp', headers: { Authorization: 'Bearer ' + data.token } } } }, null, 2);
    document.getElementById('rest').textContent = 'curl -H "Authorization: Bearer ' + data.token + '" ${url}/api/courses';
  } catch (err) { msg.textContent = err.message; msg.className = 'err'; }
  finally { b.disabled = false; }
});
</script>
</body>
</html>`;
}
