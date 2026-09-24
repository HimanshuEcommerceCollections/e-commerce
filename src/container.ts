import type { PrismaClient } from '@prisma/client';
import { AuthService } from './auth/auth.service';
import { JwtService } from './auth/jwt';
import { CartService } from './cart/cart.service';
import type { Config } from './config';
import { OrderExpiryService } from './order/expiry';
import { OrderService } from './order/order.service';
import type { PaymentGateway } from './payment/gateway';
import { ManualPaymentGateway } from './payment/manual-gateway';
import { StripePaymentGateway } from './payment/stripe-gateway';
import { WebhookEventStore } from './payment/webhook/event-store';
import { StripeWebhookService } from './payment/webhook/webhook.service';
import { CategoryService } from './product/category.service';
import { CatalogFileReader } from './product/importer/file-reader';
import { CatalogImportService } from './product/importer/import.service';
import { ProductService } from './product/product.service';
import { AddressService } from './user/address.service';

/** Every service, wired once. Tests build one with a scripted gateway. */
export interface Container {
  config: Config;
  prisma: PrismaClient;
  jwt: JwtService;
  gateway: PaymentGateway;
  auth: AuthService;
  addresses: AddressService;
  categories: CategoryService;
  products: ProductService;
  catalogImport: CatalogImportService;
  cart: CartService;
  orders: OrderService;
  expiry: OrderExpiryService;
  webhookStore: WebhookEventStore;
  /** Present only when PAYMENT_PROVIDER=stripe. */
  stripeWebhook: StripeWebhookService | null;
}

export function createContainer(
  config: Config,
  prisma: PrismaClient,
  overrides: { gateway?: PaymentGateway } = {},
): Container {
  const stripe = config.payment.provider === 'stripe';
  if (stripe) StripeWebhookService.requireRealSecret(config.payment.stripe.webhookSecret);

  const gateway =
    overrides.gateway ??
    (stripe
      ? new StripePaymentGateway(config.payment.stripe.secretKey, config.payment.stripe.timeoutMs)
      : new ManualPaymentGateway());

  const jwt = new JwtService(config.jwt.secret, config.jwt.expirationMs);
  const orders = new OrderService(prisma, gateway, config.order.currency);
  const webhookStore = new WebhookEventStore(prisma);

  return {
    config,
    prisma,
    jwt,
    gateway,
    auth: new AuthService(prisma, jwt),
    addresses: new AddressService(prisma, config.address.maxPerUser),
    categories: new CategoryService(prisma),
    products: new ProductService(prisma),
    catalogImport: new CatalogImportService(prisma, new CatalogFileReader(config.catalogImport.maxRows)),
    cart: new CartService(prisma),
    orders,
    expiry: new OrderExpiryService(prisma, gateway, config.order.pendingExpiryMinutes),
    webhookStore,
    stripeWebhook: stripe
      ? new StripeWebhookService(
          orders,
          webhookStore,
          config.payment.stripe.webhookSecret,
          config.payment.stripe.inflightLeaseSeconds,
        )
      : null,
  };
}
