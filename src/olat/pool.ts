import { createHash } from 'node:crypto';
import { OlatClient, type OlatClientOptions } from './client.js';
import type { Credentials } from './web.js';

/** Keeps one logged-in client per user and drops idle ones. */
export class OlatClientPool {
  private readonly clients = new Map<string, OlatClient>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly opts: OlatClientOptions,
    private readonly idleMs = 30 * 60_000,
  ) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  private static key(c: Credentials): string {
    return createHash('sha256').update(`${c.username}\0${c.password}`).digest('hex');
  }

  get(creds: Credentials): OlatClient {
    const k = OlatClientPool.key(creds);
    let client = this.clients.get(k);
    if (!client) {
      client = new OlatClient(creds, this.opts);
      this.clients.set(k, client);
    }
    client.web.lastUsed = Date.now();
    return client;
  }

  drop(creds: Credentials): void {
    this.clients.delete(OlatClientPool.key(creds));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, c] of this.clients) if (now - c.web.lastUsed > this.idleMs) this.clients.delete(k);
  }

  close(): void {
    clearInterval(this.timer);
    this.clients.clear();
  }
}
