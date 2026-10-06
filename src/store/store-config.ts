import { Prisma } from '@prisma/client';
import { money } from '../common/api-response';
import type { Config } from '../config';
import { baseShippingOptions } from '../order/pricing';

/**
 * GET /api/store/config: the storefront settings the web client needs before
 * any cart exists — brand, currency, tax mode, shipping methods, return
 * window, payment provider. Only public values: the Stripe publishable key is
 * meant for browsers; secrets never appear here.
 */
export function storeConfig(config: Config) {
  const stripe = config.payment.provider === 'stripe';
  return {
    storeName: config.store.name,
    currency: config.order.currency,
    pricesIncludeTax: config.pricing.pricesIncludeTax,
    freeShippingThreshold: config.shipping.freeThreshold === null ? null : money(new Prisma.Decimal(config.shipping.freeThreshold)),
    shippingOptions: baseShippingOptions(config.shipping).map((o) => ({ ...o, fee: money(o.fee) })),
    returnWindowDays: config.returns.windowDays,
    lowStockThreshold: config.inventory.lowStockThreshold,
    paymentProvider: config.payment.provider,
    stripePublishableKey: stripe && config.payment.stripe.publishableKey ? config.payment.stripe.publishableKey : null,
  };
}
