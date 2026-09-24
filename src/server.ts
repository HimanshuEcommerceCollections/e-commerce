import 'dotenv/config';
import { createApp } from './app';
import { setLogLevel, logger } from './common/logger';
import { loadConfig } from './config';
import { createContainer } from './container';
import { createPrisma } from './db';
import { startExpiryJob } from './order/expiry';

const log = logger('server');

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const prisma = createPrisma(config.databaseUrl);
  await prisma.$connect();
  const container = createContainer(config, prisma);
  const app = createApp(container);

  const server = app.listen(config.port, () => {
    log.info(`NexusCommerce API listening on port ${config.port} (payment provider: ${config.payment.provider})`);
  });
  const stopExpiry = startExpiryJob(container.expiry, config.order.expiryCheckIntervalMs);

  const shutdown = (signal: string) => {
    log.info(`${signal} received — shutting down`);
    stopExpiry();
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('Failed to start', e);
  process.exit(1);
});
