// Entry point for serverless hosting (Vercel detects the default-exported Hono app).
// For a long-running server use `src/cli.ts serve` instead.
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { OlatClientPool } from './olat/pool.js';
import { createTokenStore } from './store/create.js';

const cfg = loadConfig();

const app = new Hono();
app.route(
  '/',
  createApp({
    store: createTokenStore(cfg),
    pool: new OlatClientPool({ baseUrl: cfg.baseUrl, maxDownloadBytes: cfg.maxDownloadBytes, maxInlineBinaryBytes: cfg.maxInlineBinaryBytes, externalHosts: cfg.externalHosts }),
    baseUrl: cfg.baseUrl,
    publicUrl: cfg.publicUrl,
  }),
);

export default app;
