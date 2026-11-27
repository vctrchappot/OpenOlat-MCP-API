#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { createMcpServer } from './mcp/server.js';
import { OlatClient } from './olat/client.js';
import { OlatClientPool } from './olat/pool.js';
import { OlatRestClient } from './olat/rest.js';
import type { Credentials } from './olat/web.js';
import { CredentialStore } from './store/credentials.js';

const HELP = `openolat-mcp-api – read-only MCP-Server & API für OpenOLAT (olat.bms-w.ch)

Befehle:
  login           Anmeldedaten lokal (verschlüsselt) hinterlegen
  logout          Lokal hinterlegte Anmeldedaten löschen
  stdio           MCP-Server über stdio (für Claude Desktop/Code, lokal)
  serve           HTTP-Server: REST-API, MCP-Endpoint /mcp, Setup-Seite /

Umgebungsvariablen: OLAT_USERNAME, OLAT_PASSWORD (statt login), OLAT_BASE_URL,
  HOST, PORT, DATA_DIR, OLAT_MCP_SECRET, PUBLIC_URL, MAX_DOWNLOAD_MB`;

const cfg = loadConfig();
const clientOpts = { baseUrl: cfg.baseUrl, maxDownloadBytes: cfg.maxDownloadBytes, maxInlineBinaryBytes: cfg.maxInlineBinaryBytes };
const tokenFile = join(cfg.localDir, 'token');

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      (rl as any)._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stderr.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(answer);
    });
  });
}

function localCredentials(): Credentials | null {
  if (process.env.OLAT_USERNAME && process.env.OLAT_PASSWORD) return { username: process.env.OLAT_USERNAME, password: process.env.OLAT_PASSWORD };
  if (!existsSync(tokenFile)) return null;
  const store = new CredentialStore(cfg.localDir, cfg.secret);
  return store.resolve(readFileSync(tokenFile, 'utf8').trim())?.creds ?? null;
}

async function login() {
  const username = process.env.OLAT_USERNAME || (await prompt('OpenOLAT-Benutzername: '));
  const password = process.env.OLAT_PASSWORD || (await prompt('Passwort: ', true));
  const me = await new OlatRestClient(new URL(cfg.baseUrl), { username, password }).get<{ firstName: string; lastName: string }>('users/me');
  const store = new CredentialStore(cfg.localDir, cfg.secret);
  if (existsSync(tokenFile)) store.revoke(readFileSync(tokenFile, 'utf8').trim());
  const { token } = store.create({ username, password }, 'local');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  console.error(`✓ Angemeldet als ${me.firstName} ${me.lastName}. Zugangsdaten gespeichert in ${cfg.localDir}`);
}

function logout() {
  if (existsSync(tokenFile)) {
    new CredentialStore(cfg.localDir, cfg.secret).revoke(readFileSync(tokenFile, 'utf8').trim());
    rmSync(tokenFile);
  }
  console.error('✓ Lokale Zugangsdaten gelöscht.');
}

async function stdio() {
  const creds = localCredentials();
  if (!creds) {
    console.error('Keine Zugangsdaten: zuerst "openolat-mcp-api login" ausführen oder OLAT_USERNAME/OLAT_PASSWORD setzen.');
    process.exit(1);
  }
  const client = new OlatClient(creds, clientOpts);
  const server = createMcpServer(() => client);
  await server.connect(new StdioServerTransport());
}

function serveHttp() {
  const store = new CredentialStore(cfg.dataDir, cfg.secret);
  const pool = new OlatClientPool(clientOpts);
  const app = createApp({ store, pool, baseUrl: cfg.baseUrl, publicUrl: cfg.publicUrl });
  serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    console.error(`openolat-mcp-api läuft auf http://${info.address}:${info.port}  (Setup: /, MCP: /mcp, API: /api)`);
  });
}

const cmd = process.argv[2];
try {
  if (cmd === 'login') await login();
  else if (cmd === 'logout') logout();
  else if (cmd === 'stdio') await stdio();
  else if (cmd === 'serve') serveHttp();
  else {
    console.error(HELP);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`Fehler: ${(e as Error).message}`);
  process.exit(1);
}
