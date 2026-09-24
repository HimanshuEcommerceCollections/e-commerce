import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, inject } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig, type Config } from '../../src/config';
import { createContainer, type Container } from '../../src/container';
import type { UserRole } from '../../src/common/enums';
import type { PaymentGateway } from '../../src/payment/gateway';

export interface Harness {
  config: Config;
  prisma: PrismaClient;
  container: Container;
  app: Express;
  fixtures: ReturnType<typeof fixtures>;
}

/**
 * A full app against the test database: manual gateway unless one is passed,
 * rate limiting off unless the env says otherwise. Call at the top of a test
 * file; the client disconnects after the file.
 */
export function harness(options: { gateway?: PaymentGateway; env?: Record<string, string> } = {}): Harness {
  const config = loadConfig({
    DATABASE_URL: inject('databaseUrl'),
    JWT_SECRET: 'test-only-secret-test-only-secret-0123456789',
    PAYMENT_PROVIDER: 'manual',
    RATE_LIMIT_ENABLED: 'false',
    LOG_LEVEL: 'error',
    ...options.env,
  });
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const container = createContainer(config, prisma, { gateway: options.gateway });
  const app = createApp(container);
  afterAll(() => prisma.$disconnect());
  return { config, prisma, container, app, fixtures: fixtures(prisma, container, app) };
}

/** Test data builders. Everything is unique per call: the database is shared. */
function fixtures(prisma: PrismaClient, c: Container, app: Express) {
  const self = {
    async newCustomer(): Promise<User> {
      return prisma.user.create({
        data: {
          email: `customer-${randomUUID()}@test.local`,
          password: 'not-a-real-hash',
          fullName: 'Test Customer',
          role: 'ROLE_CUSTOMER',
        },
      });
    },

    async newActiveProduct(stock: number, price: string) {
      const sku = `SKU-${randomUUID()}`;
      const merchantId = randomUUID();
      const parent = await prisma.parentProduct.create({ data: { code: sku, name: 'Test Product', merchantId } });
      return prisma.product.create({
        data: {
          name: 'Test Product',
          sku,
          price: new Prisma.Decimal(price),
          stockQuantity: stock,
          status: 'ACTIVE',
          parentId: parent.id,
          merchantId,
          version: 0n,
        },
      });
    },

    /** Additional addresses must be non-default: uniq_user_addresses_default allows one. */
    async newAddress(userId: string, isDefault = true) {
      return prisma.userAddress.create({
        data: {
          userId,
          label: 'Home',
          recipientName: 'Test Customer',
          phone: '+1 555 000 1111',
          addressLine1: '1 Test Street',
          city: 'Testville',
          state: 'TS',
          postalCode: '12345',
          country: 'US',
          isDefault,
        },
      });
    },

    async newCategory(name: string, slug: string) {
      return prisma.productCategory.create({ data: { name, slug } });
    },

    async addToCart(userId: string, productId: string, quantity: number) {
      await c.cart.addItem(userId, { productId, quantity });
    },

    async stockOf(productId: string) {
      return (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stockQuantity;
    },

    /** Registers over HTTP, then sets the role directly (there's no API for it). Returns a token. */
    async registerUser(role: UserRole = 'ROLE_CUSTOMER'): Promise<string> {
      const email = `http-${randomUUID()}@test.local`;
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email,
          password: 'password123',
          fullName: 'Http Test',
          phoneNumber: `+1${1_000_000_000 + randomInt(8_999_999_999)}`,
        });
      if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`);
      if (role !== 'ROLE_CUSTOMER') await prisma.user.update({ where: { email }, data: { role } });
      // The role is re-read from the database on every request, so the token
      // from registration already carries the new role.
      return res.body.data.accessToken;
    },
  };
  return self;
}
