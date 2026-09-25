import cors from 'cors';
import express, { type Express } from 'express';
import { authenticate, requireAuth } from './auth/auth.middleware';
import { authRateLimit } from './auth/rate-limit';
import { errorHandler, notFoundHandler } from './common/error-handler';
import type { Container } from './container';
import {
  addressRoutes,
  authRoutes,
  cartRoutes,
  catalogImportRoutes,
  categoryRoutes,
  orderRoutes,
  productRoutes,
  stripeRoutes,
  adminRoutes,
} from './routes';

export function createApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  if (c.config.trustProxy) app.set('trust proxy', true);

  app.use(
    cors({
      origin: c.config.cors.allowedOrigins,
      credentials: true, // the web client sends withCredentials requests
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 3600,
    }),
  );

  // The auth rate limiter runs before everything, then token authentication.
  app.use(
    authRateLimit({
      enabled: c.config.rateLimit.enabled,
      capacity: c.config.rateLimit.capacity,
      refillPerMinute: c.config.rateLimit.refillPerMinute,
    }),
  );
  app.use(authenticate(c.jwt, c.prisma));

  // Registered before the JSON parser: signature checks need the raw bytes.
  if (c.stripeWebhook) app.use('/api/payments/stripe', stripeRoutes(c));

  app.use(express.json({ limit: '1mb' }));

  app.use('/actuator', healthRoutes(c));
  app.use('/api/auth', authRoutes(c));
  app.use('/api/categories', categoryRoutes(c));
  app.use('/api/products', productRoutes(c));
  app.use('/api/catalog/import', catalogImportRoutes(c));
  app.use('/api/users/me/addresses', addressRoutes(c));
  app.use('/api/cart', cartRoutes(c));
  app.use('/api/orders', orderRoutes(c));
  app.use('/api/admin', adminRoutes(c));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Spring Actuator-compatible probes (the Docker HEALTHCHECK uses readiness). */
function healthRoutes(c: Container) {
  const r = express.Router();
  const dbUp = async () => {
    try {
      await c.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  };
  r.get('/health', async (_req, res) => {
    const up = await dbUp();
    res.status(up ? 200 : 503).json({ status: up ? 'UP' : 'DOWN', groups: ['liveness', 'readiness'] });
  });
  r.get('/health/liveness', (_req, res) => {
    res.json({ status: 'UP' });
  });
  r.get('/health/readiness', async (_req, res) => {
    const up = await dbUp();
    res.status(up ? 200 : 503).json({ status: up ? 'UP' : 'OUT_OF_SERVICE' });
  });
  r.get('/info', requireAuth, (_req, res) => {
    res.json({});
  });
  return r;
}
