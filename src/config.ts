import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  baseUrl: string;
  host: string;
  port: number;
  dataDir: string;
  localDir: string;
  /** "file": encrypted credentials.json in dataDir; "stateless": token carries the encrypted credentials (needs OLAT_MCP_SECRET). */
  storeMode: 'file' | 'stateless';
  secret?: string;
  publicUrl?: string;
  maxDownloadBytes: number;
  maxInlineBinaryBytes: number;
}

export function loadConfig(env = process.env): Config {
  return {
    baseUrl: env.OLAT_BASE_URL ?? 'https://olat.bms-w.ch',
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? join(process.cwd(), 'data'),
    localDir: env.OPENOLAT_MCP_API_HOME ?? join(homedir(), '.openolat-mcp-api'),
    storeMode: (env.STORE ?? (env.VERCEL ? 'stateless' : 'file')) === 'stateless' ? 'stateless' : 'file',
    secret: env.OLAT_MCP_SECRET || undefined,
    publicUrl: env.PUBLIC_URL || undefined,
    maxDownloadBytes: Number(env.MAX_DOWNLOAD_MB ?? 30) * 1024 * 1024,
    maxInlineBinaryBytes: Number(env.MAX_INLINE_MB ?? 4) * 1024 * 1024,
  };
}
