// Vercel serverless entry point. Exposes the Express app as the request handler
// for every route (see vercel.json rewrites). Local dev, Docker and other
// long-lived hosts keep using `npm run dev` / `npm start`, which run
// src/server.ts and call app.listen(). Vercel never runs a long-lived listener,
// so the pending-order expiry job is driven by a Vercel cron (vercel.json)
// hitting /internal/cron/expire-pending instead of setTimeout.
//
// loadConfig() validates env at import time: a missing or placeholder
// JWT_SECRET / DATABASE_URL crashes the function on cold start and every route
// returns 500. Set them in the Vercel project's Environment Variables.
import 'dotenv/config';
import express from 'express';
import { createApp } from '../src/app';
import { logger, setLogLevel } from '../src/common/logger';
import { loadConfig } from '../src/config';
import { createContainer } from '../src/container';
import { createPrisma } from '../src/db';

const log = logger('vercel');

const config = loadConfig();
setLogLevel(config.logLevel);

// Module scope so a warm function reuses one Prisma client and connection.
const prisma = createPrisma(config.databaseUrl);
const container = createContainer(config, prisma);
const api = createApp(container);

const app = express();
app.disable('x-powered-by');

// Vercel cron sends `Authorization: Bearer <CRON_SECRET>` when the env var is
// set. Mounted before the API so it is not swallowed by its 404 handler.
app.get('/internal/cron/expire-pending', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    const expired = await container.expiry.expireAbandonedOrders();
    res.json({ success: true, expired });
  } catch (e) {
    log.error('Pending-order expiry scan failed', e);
    res.status(500).json({ success: false, message: 'Expiry scan failed' });
  }
});

app.use(api);

export default app;
