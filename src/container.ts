import type { PrismaClient } from '@prisma/client';
import { BuyAgainService } from './account/buy-again.service';
import { GiftCardService } from './account/gift-cards.service';
import { NotificationPrefsService } from './account/notification-prefs.service';
import { PaymentMethodService } from './account/payment-methods.service';
import { PrivacyService } from './account/privacy.service';
import { SessionService } from './account/sessions.service';
import { StoreCreditService } from './account/store-credit.service';
import { TwoFactorService } from './account/two-factor.service';
import { CustomerReturnService } from './account/returns.service';
import { ReviewService } from './account/reviews.service';
import { SavedItemService } from './account/saved-items.service';
import { AccountSummaryService } from './account/summary.service';
import { CatalogAdminService } from './admin/catalog.service';
import { AdminCustomerService } from './admin/customers.service';
import { AdminInboxService } from './admin/inbox.service';
import { AdminPromotionService } from './admin/promotions.service';
import { AdminOrderService } from './admin/orders.service';
import { AdminReportService } from './admin/reports.service';
import { AdminReturnService } from './admin/returns.service';
import { AnalyticsService } from './analytics/analytics.service';
import { AuthService } from './auth/auth.service';
import { JwtService } from './auth/jwt';
import { CartService } from './cart/cart.service';
import { PromotionService } from './promo/promotion.service';
import { StorefrontService } from './product/storefront.service';
import { Mailer } from './notify/mailer';
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
import { CatalogBulkUpdateService } from './product/importer/bulk-update.service';
import { CatalogExportService } from './product/importer/export.service';
import { ImageCheckService } from './product/image-check';
import { pricingRules } from './order/pricing';
import { ProductService } from './product/product.service';
import { SellerSubmissionService } from './seller/submission.service';
import { ManualShippingProvider } from './shipping/manual-provider';
import type { ShippingProvider } from './shipping/shipping-provider';
import { SupportService } from './support/support.service';
import { AccountService } from './user/account.service';
import { AddressService } from './user/address.service';

/** Every service, wired once. Tests build one with a scripted gateway. */
export interface Container {
  config: Config;
  prisma: PrismaClient;
  jwt: JwtService;
  gateway: PaymentGateway;
  auth: AuthService;
  addresses: AddressService;
  /** The signed-in user's profile and password. */
  accounts: AccountService;
  /** Help-center messages and seller applications. */
  support: SupportService;
  /** Storefront funnel events (FR-IN-05). */
  analytics: AnalyticsService;
  categories: CategoryService;
  products: ProductService;
  /** Promo codes (contract B1). */
  promotions: PromotionService;
  /** Server-side PLP search, facets, related items, recommendations, suggestions (contract A). */
  storefront: StorefrontService;
  catalogImport: CatalogImportService;
  /** Bulk price/stock/status updates (FR-IM-10). */
  catalogUpdates: CatalogBulkUpdateService;
  /** Catalog export in the template's columns (NFR-06). */
  catalogExport: CatalogExportService;
  /** Image URL checks (FR-IM-08). */
  imageChecks: ImageCheckService;
  /** Admin catalog: products, variants, inventory, images (FR-AD-01/03/05). */
  catalogAdmin: CatalogAdminService;
  /** Seller portal: submissions, review decisions and seller stock. */
  submissions: SellerSubmissionService;
  cart: CartService;
  orders: OrderService;
  /** Account home tiles (contract C1). */
  accountSummary: AccountSummaryService;
  /** Saved items / hearts (C5). */
  savedItems: SavedItemService;
  /** The customer's returns list (C3). */
  customerReturns: CustomerReturnService;
  /** Buy again (C4). */
  buyAgain: BuyAgainService;
  /** Product reviews: customer, public and moderation (C6). */
  reviews: ReviewService;
  /** Admin operations: orders, fulfilment, shipping, cancellation (FR-AD-02/04, FR-IN-03/04). */
  adminOrders: AdminOrderService;
  /** Returns and refunds (FR-AD-07). */
  adminReturns: AdminReturnService;
  /** Customer records and staff roles (FR-AD-06/08). */
  adminCustomers: AdminCustomerService;
  /** Support messages and seller applications inbox (contract D1). */
  adminInbox: AdminInboxService;
  /** Promotion codes CRUD (contract D3). */
  adminPromotions: AdminPromotionService;
  /** Analytics summary, sales report, settings. */
  adminReports: AdminReportService;
  /** SHIPPING_PROVIDER (manual only for now). */
  shipping: ShippingProvider;
  expiry: OrderExpiryService;
  webhookStore: WebhookEventStore;
  /** Log-only customer messages (notifications table). Never throws. */
  mailer: Mailer;
  /** Present only when PAYMENT_PROVIDER=stripe. */
  stripeWebhook: StripeWebhookService | null;
  // ── Account settings (contract C8–C13) ──
  /** Signed-in devices (user_sessions). */
  sessions: SessionService;
  /** 2-step verification codes (log-only "SMS"). */
  twoFactor: TwoFactorService;
  notificationPrefs: NotificationPrefsService;
  storeCredit: StoreCreditService;
  giftCards: GiftCardService;
  /** Saved cards; 501 unless the gateway has a vault (Stripe). */
  paymentMethods: PaymentMethodService;
  /** Data export and account deletion. */
  privacy: PrivacyService;
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
  const webhookStore = new WebhookEventStore(prisma);
  const mailer = new Mailer(prisma, config.mail.provider);
  const analytics = new AnalyticsService(prisma);
  const orders = new OrderService(prisma, gateway, config, { mailer, analytics });
  const sessions = new SessionService(prisma, Math.max(config.jwt.expirationMs, config.jwt.rememberExpirationMs));
  const twoFactor = new TwoFactorService(prisma, mailer, config.store.name);
  const auth = new AuthService(prisma, jwt, config, mailer, sessions, twoFactor);
  const paymentMethods = new PaymentMethodService(prisma, gateway);
  const shipping: ShippingProvider = new ManualShippingProvider();
  const catalogReader = new CatalogFileReader(config.catalogImport.maxRows);
  const imageChecks = new ImageCheckService(prisma, config.imageChecks);
  const catalogImport = new CatalogImportService(prisma, catalogReader, imageChecks, config.order.currency);
  const catalogExport = new CatalogExportService(prisma, config.order.currency);
  const promotions = new PromotionService(prisma);
  const cart = new CartService(prisma, pricingRules(config), config.order.currency, promotions);
  const savedItems = new SavedItemService(prisma, cart);
  const customerReturns = new CustomerReturnService(prisma, config);

  return {
    config,
    prisma,
    jwt,
    gateway,
    auth,
    addresses: new AddressService(prisma, config.address.maxPerUser),
    accounts: new AccountService(prisma, auth, sessions),
    support: new SupportService(prisma, mailer, config),
    analytics,
    categories: new CategoryService(prisma),
    products: new ProductService(prisma),
    promotions,
    storefront: new StorefrontService(prisma, config.inventory.lowStockThreshold),
    catalogImport,
    catalogUpdates: new CatalogBulkUpdateService(prisma, catalogReader),
    catalogExport,
    imageChecks,
    catalogAdmin: new CatalogAdminService(prisma, catalogImport, imageChecks, config.inventory.lowStockThreshold),
    submissions: new SellerSubmissionService(prisma, catalogReader, catalogImport, catalogExport, imageChecks, mailer, config),
    cart,
    orders,
    accountSummary: new AccountSummaryService(prisma, orders, customerReturns, savedItems),
    savedItems,
    customerReturns,
    buyAgain: new BuyAgainService(prisma),
    reviews: new ReviewService(prisma, config, mailer),
    adminOrders: new AdminOrderService(prisma, gateway, orders, shipping, mailer, config),
    adminReturns: new AdminReturnService(prisma, gateway, mailer, config),
    adminCustomers: new AdminCustomerService(prisma),
    adminInbox: new AdminInboxService(prisma),
    adminPromotions: new AdminPromotionService(prisma),
    adminReports: new AdminReportService(prisma, gateway, config),
    shipping,
    expiry: new OrderExpiryService(prisma, gateway, config.order.pendingExpiryMinutes),
    webhookStore,
    mailer,
    stripeWebhook: stripe
      ? new StripeWebhookService(
          orders,
          webhookStore,
          config.payment.stripe.webhookSecret,
          config.payment.stripe.inflightLeaseSeconds,
        )
      : null,
    sessions,
    twoFactor,
    notificationPrefs: new NotificationPrefsService(prisma),
    storeCredit: new StoreCreditService(prisma, config),
    giftCards: new GiftCardService(prisma, mailer, config),
    paymentMethods,
    privacy: new PrivacyService(prisma, mailer, config, sessions, paymentMethods),
  };
}
