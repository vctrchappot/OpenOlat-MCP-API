import type { Config } from '../config.js';
import { CredentialStore, type TokenStore } from './credentials.js';
import { StatelessTokenStore } from './stateless.js';

/** Picks the store: stateless (Vercel / STORE=stateless) or the encrypted file store. */
export function createTokenStore(cfg: Pick<Config, 'storeMode' | 'dataDir' | 'secret'>): TokenStore {
  return cfg.storeMode === 'stateless' ? new StatelessTokenStore(cfg.secret) : new CredentialStore(cfg.dataDir, cfg.secret);
}
