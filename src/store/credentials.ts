import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Credentials } from '../olat/web.js';

interface Entry {
  id: string;
  tokenHash: string;
  username: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface FileShape {
  version: 1;
  entries: Entry[];
}

export interface TokenInfo {
  id: string;
  username: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** What the HTTP app needs from a credential store. */
export interface TokenStore {
  /** False if tokens cannot be revoked individually (stateless store). */
  readonly revocable: boolean;
  create(creds: Credentials, label?: string): { token: string; info: TokenInfo };
  resolve(token: string): { creds: Credentials; info: TokenInfo } | null;
  revoke(token: string, allForUser?: boolean): number;
  listForToken(token: string): TokenInfo[];
}

const TOKEN_RE = /^olat_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

/**
 * Stores OpenOLAT credentials encrypted at rest.
 *
 * Each registration yields an API token `olat_<id>_<secret>`. The password is encrypted with
 * AES-256-GCM using a key derived (HKDF) from the token secret and the server secret, so it can
 * only be decrypted when the token is presented. The store itself keeps a SHA-256 hash of the
 * secret, never the token.
 */
export class CredentialStore implements TokenStore {
  readonly revocable = true;
  private readonly file: string;
  private readonly serverSecret: Buffer;
  private data: FileShape;

  constructor(dataDir: string, serverSecret?: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'credentials.json');
    this.serverSecret = serverSecret ? Buffer.from(serverSecret, 'utf8') : CredentialStore.loadOrCreateKey(join(dataDir, 'server.key'));
    this.data = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as FileShape) : { version: 1, entries: [] };
  }

  private static loadOrCreateKey(path: string): Buffer {
    if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    const key = randomBytes(32);
    writeFileSync(path, key.toString('base64'), { mode: 0o600 });
    return key;
  }

  private persist(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private deriveKey(secret: string, salt: Buffer): Buffer {
    return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), salt, Buffer.concat([Buffer.from('olat-mcp-v1:'), this.serverSecret]), 32));
  }

  private static hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /** Stores the credentials and returns the new API token (shown to the user once). */
  create(creds: Credentials, label?: string): { token: string; info: TokenInfo } {
    const id = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.deriveKey(secret, salt), iv);
    cipher.setAAD(Buffer.from(`${id}:${creds.username}`));
    const ciphertext = Buffer.concat([cipher.update(creds.password, 'utf8'), cipher.final()]);
    const entry: Entry = {
      id,
      tokenHash: CredentialStore.hash(secret),
      username: creds.username,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      label: label?.slice(0, 100),
      createdAt: new Date().toISOString(),
    };
    this.data.entries.push(entry);
    this.persist();
    return { token: `olat_${id}_${secret}`, info: CredentialStore.info(entry) };
  }

  private find(token: string): { entry: Entry; secret: string } | null {
    const m = TOKEN_RE.exec(token.trim());
    if (!m) return null;
    const entry = this.data.entries.find((e) => e.id === m[1]);
    if (!entry) return null;
    const a = Buffer.from(entry.tokenHash, 'hex');
    const b = Buffer.from(CredentialStore.hash(m[2]), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { entry, secret: m[2] };
  }

  /** Resolves a token to the decrypted credentials, or null if the token is unknown. */
  resolve(token: string): { creds: Credentials; info: TokenInfo } | null {
    const hit = this.find(token);
    if (!hit) return null;
    const { entry, secret } = hit;
    const decipher = createDecipheriv('aes-256-gcm', this.deriveKey(secret, Buffer.from(entry.salt, 'base64')), Buffer.from(entry.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${entry.id}:${entry.username}`));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    const password = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    const now = new Date().toISOString();
    if (!entry.lastUsedAt || Date.parse(now) - Date.parse(entry.lastUsedAt) > 60_000) {
      entry.lastUsedAt = now;
      this.persist();
    }
    return { creds: { username: entry.username, password }, info: CredentialStore.info(entry) };
  }

  /** Deletes the token's entry. With `allForUser`, every token of the same username is deleted. */
  revoke(token: string, allForUser = false): number {
    const hit = this.find(token);
    if (!hit) return 0;
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => (allForUser ? e.username !== hit.entry.username : e.id !== hit.entry.id));
    this.persist();
    return before - this.data.entries.length;
  }

  listForToken(token: string): TokenInfo[] {
    const hit = this.find(token);
    if (!hit) return [];
    return this.data.entries.filter((e) => e.username === hit.entry.username).map(CredentialStore.info);
  }

  private static info(e: Entry): TokenInfo {
    return { id: e.id, username: e.username, label: e.label, createdAt: e.createdAt, lastUsedAt: e.lastUsedAt };
  }
}
