import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { Credentials } from '../olat/web.js';
import type { TokenInfo, TokenStore } from './credentials.js';

interface Payload {
  u: string;
  p: string;
  l?: string;
  c: string;
}

const PREFIX = 'olat_s1_';
const MIN_SECRET_LENGTH = 32;

/**
 * Stateless token store for platforms without a persistent filesystem (e.g. Vercel).
 *
 * The token *is* the credential: `olat_s1_<base64url(salt|iv|tag|ciphertext)>`, where the ciphertext
 * (username, password) is encrypted with AES-256-GCM under a key derived (HKDF) from the server secret.
 * Nothing is stored server-side. Tokens cannot be revoked individually; rotating the server secret
 * (or changing the OpenOLAT password) invalidates them all.
 */
export class StatelessTokenStore implements TokenStore {
  readonly revocable = false;
  private readonly secret: Buffer;

  constructor(serverSecret: string | undefined) {
    if (!serverSecret || serverSecret.length < MIN_SECRET_LENGTH) {
      throw new Error(`OLAT_MCP_SECRET muss gesetzt sein (mindestens ${MIN_SECRET_LENGTH} Zeichen), z.B. "openssl rand -base64 48".`);
    }
    this.secret = Buffer.from(serverSecret, 'utf8');
  }

  private key(salt: Buffer): Buffer {
    return Buffer.from(hkdfSync('sha256', this.secret, salt, 'olat-mcp-stateless-v1', 32));
  }

  create(creds: Credentials, label?: string): { token: string; info: TokenInfo } {
    const payload: Payload = { u: creds.username, p: creds.password, l: label?.slice(0, 100), c: new Date().toISOString() };
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(salt), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const token = PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    return { token, info: StatelessTokenStore.info(token, payload) };
  }

  resolve(token: string): { creds: Credentials; info: TokenInfo } | null {
    const t = token.trim();
    if (!t.startsWith(PREFIX)) return null;
    const raw = Buffer.from(t.slice(PREFIX.length), 'base64url');
    if (raw.length < 16 + 12 + 16 + 1) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(raw.subarray(0, 16)), raw.subarray(16, 28));
      decipher.setAuthTag(raw.subarray(28, 44));
      const payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(44)), decipher.final()]).toString('utf8')) as Payload;
      return { creds: { username: payload.u, password: payload.p }, info: StatelessTokenStore.info(t, payload) };
    } catch {
      return null;
    }
  }

  revoke(): number {
    return 0;
  }

  listForToken(token: string): TokenInfo[] {
    const hit = this.resolve(token);
    return hit ? [hit.info] : [];
  }

  private static info(token: string, p: Payload): TokenInfo {
    return { id: createHash('sha256').update(token).digest('hex').slice(0, 16), username: p.u, label: p.l, createdAt: p.c };
  }
}
