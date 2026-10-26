import { createHash, createHmac, randomInt } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { reconcileProviderRefund } from '../admin/refund-reconciliation';
import type { AnalyticsService } from '../analytics/analytics.service';
import { CART_PRODUCT_INCLUDE, type CartProduct } from '../cart/cart-pricing';
import { CartLinesSchema, type CartLineInput } from '../cart/cart.service';
import { RETURN_METHODS, RETURN_REFUND_TARGETS, SHIPPING_METHODS, type OrderStatus, type ShippingMethod } from '../common/enums';
import {
  AddressNotFoundError,
  DomainError,
  EmptyCartError,
  IdempotencyKeyConflictError,
  InvalidIdempotencyKeyError,
  InvalidOrderStateError,
  OrderNotFoundError,
  OutOfStockError,
  PaymentAmountMismatchError,
  ProductUnavailableError,
} from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { logger } from '../common/logger';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import {
  flag,
  integer,
  isUuid,
  oneOf,
  optionalString,
  optionalUuid,
  requiredString,
  requiredUuid,
  ValidationError,
} from '../common/validation';
import type { Config } from '../config';
import { TX, type Db } from '../db';
import type { Mailer } from '../notify/mailer';
import type { PaymentEventHandler, PaymentGateway } from '../payment/gateway';
import { toMinorUnits } from '../payment/money-units';
import { primaryImageUrl } from '../product/product.mapper';
import { promoCodeField, resolvePromotion } from '../promo/promotion.service';
import { checkUsAddress, isPoBox, normalizeState, saveCheckoutAddress, US_ZIP } from '../user/address.service';
import { TaxDestinationSchema } from '../cart/cart.service';
import {
  orderCancelledMail,
  orderPlacedMail,
  paymentReceivedMail,
  returnRequestedMail,
  type MailContext,
} from './order-emails';
import { recordOrderEvent } from './order-events';
import { generateOrderNumber, generateRmaNumber, normalizeOrderNumber } from './order-number';
import {
  ORDER_DETAIL_INCLUDE,
  ORDER_ITEMS_INCLUDE,
  ORDER_SUMMARY_INCLUDE,
  orderView,
  postalCode5,
  returnableUntil,
  toOrderResponse,
  toOrderSummaryResponse,
  toReturnResponse,
  toTrackedOrder,
  type CheckoutResponse,
  type OrderDetail,
  type OrderView,
  type OrderWithItems,
} from './order.mapper';
import {
  claimPaid,
  claimPendingCancellation,
  claimRefundCancellation,
  lockOrderRow,
  markRefundedOnCancelled,
  restock,
  takeStock,
} from './order.repository';
import { priceLines, pricingRules, savings, type LineAmounts, type PricingRules } from './pricing';

const log = logger('orders');

// ── Request schemas ─────────────────────────────────────────────────────────

/** A shipping address typed at checkout (country defaults to US). */
const ShippingAddressFields = z.object(
  {
    recipientName: requiredString({
      blankMessage: 'Recipient name is required',
      max: 200,
      sizeMessage: 'Recipient name must not exceed 200 characters',
    }),
    phone: optionalString({
      max: 20,
      sizeMessage: 'Phone must not exceed 20 characters',
      pattern: /^$|^\+?[0-9 ()\-]{6,20}$/,
      patternMessage: "Phone must contain only digits, spaces, parentheses, hyphens, and an optional leading '+'",
    }),
    addressLine1: requiredString({
      blankMessage: 'Address line 1 is required',
      max: 255,
      sizeMessage: 'Address line 1 must not exceed 255 characters',
    }),
    addressLine2: optionalString({ max: 255, sizeMessage: 'Address line 2 must not exceed 255 characters' }),
    city: requiredString({ blankMessage: 'City is required', max: 100, sizeMessage: 'City must not exceed 100 characters' }),
    state: requiredString({ blankMessage: 'State is required', max: 100, sizeMessage: 'State must not exceed 100 characters' }),
    postalCode: requiredString({
      blankMessage: 'Postal code is required',
      max: 20,
      sizeMessage: 'Postal code must not exceed 20 characters',
    }),
    country: optionalString({ max: 100, sizeMessage: 'Country must not exceed 100 characters' }),
  },
  { required_error: 'Shipping address is required', invalid_type_error: 'Shipping address must be an object' },
);

/** US addresses: a state of the 50 + DC and a 5-digit ZIP (contract B4). */
export const ShippingAddressInputSchema = ShippingAddressFields.superRefine((a, ctx) => checkUsAddress(a, ctx));

export type ShippingAddressInput = z.output<typeof ShippingAddressInputSchema>;

const nullToUndefined = (v: unknown) => (v === null ? undefined : v);

/** Card billing address when it differs from shipping (street and ZIP are all the card check needs). */
const BillingAddressSchema = z.preprocess(
  nullToUndefined,
  z
    .object({
      addressLine1: optionalString({ max: 255, sizeMessage: 'Address line 1 must not exceed 255 characters' }),
      postalCode: optionalString({ max: 20 }),
    })
    .optional(),
);

/** Fields every checkout takes besides the address: promo code and billing (contract B1, B3). */
const checkoutExtras = {
  promoCode: promoCodeField(),
  billingSameAsShipping: z.preprocess((v) => (v === null || v === undefined ? true : v), flag()),
  billingAddress: BillingAddressSchema,
};

/** Billing street and ZIP when not the same as shipping; no P.O. box for Express. */
function checkBillingAndMethod(
  v: {
    billingSameAsShipping: boolean;
    billingAddress?: { addressLine1?: string; postalCode?: string };
    shippingAddress?: { addressLine1: string };
    shippingMethod?: ShippingMethod;
  },
  ctx: z.RefinementCtx,
) {
  if (!v.billingSameAsShipping) {
    if (!v.billingAddress?.addressLine1?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['billingAddress', 'addressLine1'], message: 'Enter your billing street address.' });
    }
    if (!US_ZIP.test(v.billingAddress?.postalCode?.trim() ?? '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['billingAddress', 'postalCode'], message: 'Enter a 5-digit billing ZIP code.' });
    }
  }
  if (v.shippingMethod === 'EXPRESS' && isPoBox(v.shippingAddress?.addressLine1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shippingAddress', 'addressLine1'], message: PO_BOX_EXPRESS });
  }
}

const PO_BOX_EXPRESS = "We can't ship Express to a P.O. box.";

/** Signed-in checkout: a saved address, or one typed in (optionally saved). */
export const CheckoutSchema = z
  .object({
    addressId: optionalUuid(),
    shippingAddress: z.preprocess(nullToUndefined, ShippingAddressInputSchema.optional()),
    saveAddress: flag(),
    shippingMethod: oneOf(SHIPPING_METHODS),
    ...checkoutExtras,
  })
  .superRefine((v, ctx) => {
    checkBillingAndMethod(v, ctx);
    if (!v.addressId && !v.shippingAddress) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['addressId'], message: 'Shipping address id is required' });
    } else if (v.addressId && v.shippingAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shippingAddress'],
        message: 'Send either addressId or shippingAddress, not both',
      });
    }
  });

export interface CheckoutInput {
  addressId?: string;
  shippingAddress?: ShippingAddressInput;
  saveAddress?: boolean;
  shippingMethod?: ShippingMethod;
  promoCode?: string;
  /** Default true. */
  billingSameAsShipping?: boolean;
  billingAddress?: { addressLine1?: string; postalCode?: string };
}

export const GuestCheckoutSchema = z.object({
  email: requiredString({
    blankMessage: 'Email is required',
    email: true,
    emailMessage: 'Must be a valid email address',
    max: 255,
    sizeMessage: 'Email must not exceed 255 characters',
  }),
  marketingOptIn: flag(),
  shippingAddress: z.preprocess(nullToUndefined, ShippingAddressInputSchema),
  shippingMethod: oneOf(SHIPPING_METHODS),
  items: z.preprocess(nullToUndefined, CartLinesSchema.min(1, 'Your cart is empty')),
  ...checkoutExtras,
}).superRefine(checkBillingAndMethod);

export type GuestCheckoutInput = z.output<typeof GuestCheckoutSchema>;

/**
 * Checkout quote: the caller's lines, or (signed in, no lines) the server
 * cart; an optional promo code (and the guest's email for first-order codes)
 * and ship-to state for destination tax.
 */
export const QuoteSchema = z.object({
  items: z.preprocess(nullToUndefined, CartLinesSchema.optional()),
  shippingMethod: oneOf(SHIPPING_METHODS),
  promoCode: promoCodeField(),
  email: optionalString({ max: 255 }),
  shippingAddress: TaxDestinationSchema,
});

export const ReturnRequestSchema = z.object({
  items: z
    .array(
      z.object({
        orderItemId: requiredUuid(),
        quantity: integer({ required: true, positive: true, max: 999 }),
      }),
      { required_error: 'must not be null', invalid_type_error: 'must be a list of { orderItemId, quantity }' },
    )
    .min(1, 'Choose at least one item to return')
    .max(100),
  reason: requiredString({ blankMessage: 'Reason is required', max: 1000, sizeMessage: 'Reason must not exceed 1000 characters' }),
  method: oneOf(RETURN_METHODS),
  refundTo: oneOf(RETURN_REFUND_TARGETS),
  /** PICKUP only: a weekday in the next two weeks (default: the next business day). */
  pickupDate: optionalString({ pattern: /^\d{4}-\d{2}-\d{2}(T.*)?$/, patternMessage: 'Choose a pickup date.' }),
});

/** Drop off within two weeks; pickups come between these hours. */
const DROPOFF_DAYS = 14;
const PICKUP_WINDOW = '9 AM – 7 PM';
const PICKUP_HORIZON_DAYS = 14;
const DAY_MS = 86_400_000;

/** UTC midnight of `d` plus `days`. */
const utcDay = (d: Date, days = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/** The requested pickup day (validated), or the next business day. */
export function pickupDay(requested: string | undefined, now = new Date()): Date {
  const today = utcDay(now);
  if (requested === undefined) {
    let day = utcDay(now, 1);
    while (isWeekend(day)) day = utcDay(day, 1);
    return day;
  }
  const day = new Date(`${requested.slice(0, 10)}T00:00:00Z`);
  const days = (day.getTime() - today.getTime()) / DAY_MS;
  if (Number.isNaN(day.getTime()) || days < 1 || days > PICKUP_HORIZON_DAYS || isWeekend(day)) {
    throw new ValidationError({ pickupDate: 'Choose a weekday in the next 2 weeks.' });
  }
  return day;
}

/** Shown as a QR code at the UPS counter: the RMA number plus 6 random characters. */
function dropoffCode(rmaNumber: string) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += alphabet[randomInt(alphabet.length)];
  return `${rmaNumber}-${suffix}`;
}

/** Order number plus the order's email or a ZIP (shipping or billing). */
export const TrackOrderSchema = z.object({
  orderNumber: requiredString({ blankMessage: 'Order number is required', max: 40, sizeMessage: 'Order number must not exceed 40 characters' }),
  emailOrZip: requiredString({ blankMessage: 'Email or ZIP code is required', max: 255, sizeMessage: 'size must be between 0 and 255' }),
});

export const ORDER_SORTS = ['createdAt', 'updatedAt', 'orderNumber', 'grandTotal', 'status'] as const;

/**
 * Account order list tabs: open = still on its way; delivered = arrived, nothing
 * sent back; returned = a (not rejected) return or fully refunded; cancelled;
 * done = finished one way or another (kept for older clients).
 */
export const ORDER_LIST_FILTERS = ['open', 'delivered', 'returned', 'cancelled', 'done'] as const;
export type OrderListFilter = (typeof ORDER_LIST_FILTERS)[number];
const DONE_STATUSES: OrderStatus[] = ['DELIVERED', 'CANCELLED', 'REFUNDED', 'PAYMENT_FAILED'];
const OPEN_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'CONFIRMED', 'SHIPPED'];
const CANCELLED_STATUSES: OrderStatus[] = ['CANCELLED', 'PAYMENT_FAILED'];

/** Account order list query: tab, search (order number or item name) and period (30d, 3m, 6m or a year). */
export interface OrderListQuery {
  status?: OrderListFilter;
  q?: string;
  period?: string;
}

/** `?status=&q=&period=` from the query string; a bad value is a 400 on that field. */
export function parseOrderListQuery(query: Record<string, unknown>): OrderListQuery {
  const str = (name: string) => {
    const v = query[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const status = str('status');
  if (status !== undefined && !(ORDER_LIST_FILTERS as readonly string[]).includes(status)) {
    throw new ValidationError({ status: `must be one of ${ORDER_LIST_FILTERS.join(', ')}` });
  }
  const period = str('period');
  if (period !== undefined) periodRange(period);
  const q = str('q');
  if (q !== undefined && q.length > 100) throw new ValidationError({ q: 'size must be between 0 and 100' });
  return { status: status as OrderListFilter | undefined, q, period };
}

function periodRange(period: string, now = new Date()): { gte: Date; lt?: Date } {
  const months = { '3m': 3, '6m': 6 }[period];
  if (period === '30d') return { gte: new Date(now.getTime() - 30 * DAY_MS) };
  if (months) return { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate())) };
  if (/^\d{4}$/.test(period)) {
    const year = Number(period);
    return { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) };
  }
  throw new ValidationError({ period: 'must be one of 30d, 3m, 6m or a year (YYYY)' });
}

/** A return that counts for the tabs: anything but a rejected request. */
const COUNTED_RETURN = { status: { not: 'REJECTED' } } satisfies Prisma.OrderReturnWhereInput;

function tabWhere(status: OrderListFilter | undefined): Prisma.OrderWhereInput {
  switch (status) {
    case 'open':
      return { status: { in: OPEN_STATUSES } };
    case 'delivered':
      return { status: 'DELIVERED', returns: { none: COUNTED_RETURN } };
    case 'returned':
      return { OR: [{ status: 'REFUNDED' }, { status: 'DELIVERED', returns: { some: COUNTED_RETURN } }] };
    case 'cancelled':
      return { status: { in: CANCELLED_STATUSES } };
    case 'done':
      return { status: { in: DONE_STATUSES } };
    default:
      return {};
  }
}

function orderListWhere(userId: string, query: OrderListQuery): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [tabWhere(query.status)];
  if (query.period) and.push({ createdAt: periodRange(query.period) });
  if (query.q) {
    and.push({
      OR: [
        { orderNumber: { contains: query.q, mode: 'insensitive' } },
        { orderNumber: normalizeOrderNumber(query.q) },
        { items: { some: { deleted: false, productName: { contains: query.q, mode: 'insensitive' } } } },
      ],
    });
  }
  return { userId, deleted: false, AND: and };
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/** Return requests count against a line unless rejected. */
const LIVE_RETURN_STATUSES = ['REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED'];

export class TrackedOrderNotFoundError extends DomainError {
  constructor() {
    super(404, "We couldn't find an order with those details");
  }
}

export interface OrderServiceDeps {
  mailer: Mailer;
  analytics: AnalyticsService;
}

/** Where a new order's lines, address and customer come from. */
interface Placement {
  userId: string | null;
  email: string;
  marketingOptIn: boolean;
  /** Lines from this user's server cart (consumed by the order), or the guest's own. */
  source: { cartOf: string } | { items: CartLineInput[] };
  address: { savedId: string } | { inline: ShippingAddressInput; save: boolean };
  method: ShippingMethod;
  guestTokenHash: string | null;
  /** Timeline / stock-movement actor: CUSTOMER or GUEST. */
  actor: string;
  promoCode: string | null;
  billing: { same: boolean; addressLine1: string | null; postalCode: string | null };
}

/** Billing as stored: nothing extra when it is the shipping address. */
function billingOf(input: { billingSameAsShipping?: boolean; billingAddress?: { addressLine1?: string; postalCode?: string } }) {
  const same = input.billingSameAsShipping ?? true;
  return same
    ? { same, addressLine1: null, postalCode: null }
    : { same, addressLine1: input.billingAddress?.addressLine1?.trim() || null, postalCode: input.billingAddress?.postalCode?.trim() || null };
}

/** Part of the idempotency hash only when set, so earlier requests keep their hash. */
function extrasHash(input: { promoCode?: string } & Parameters<typeof billingOf>[0]) {
  const extras: Record<string, unknown> = {};
  if (input.promoCode?.trim()) extras.p = input.promoCode.trim().toUpperCase();
  if (input.billingSameAsShipping === false) extras.b = billingOf(input);
  return Object.keys(extras).length ? JSON.stringify(extras) : '';
}

interface AddressSnapshot {
  recipientName: string;
  phone: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export class OrderService implements PaymentEventHandler {
  private readonly currency: string;
  private readonly rules: PricingRules;
  private readonly view: OrderView;
  private readonly mail: MailContext;
  private readonly guestTokenSecret: Buffer;
  private readonly maxAddresses: number;
  private readonly mailer: Mailer;
  private readonly analytics: AnalyticsService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly gateway: PaymentGateway,
    config: Config,
    deps: OrderServiceDeps,
  ) {
    this.currency = config.order.currency;
    this.rules = pricingRules(config);
    this.view = orderView(config);
    this.mail = { storeName: config.store.name, appBaseUrl: config.store.appBaseUrl };
    this.guestTokenSecret = Buffer.from(`guest-order:${config.jwt.secret}`, 'utf8');
    this.maxAddresses = config.address.maxPerUser;
    this.mailer = deps.mailer;
    this.analytics = deps.analytics;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────

  /**
   * Signed-in checkout from the server cart, with Idempotency-Key semantics:
   *  1. an order already created under (user, key) is replayed as-is (422 if
   *     the key was reused with a different request);
   *  2. otherwise checkout runs with the key stamped on the order;
   *  3. if two same-key requests race, uniq_orders_user_idempotency_key fails
   *     the loser's insert (its whole transaction, stock decrements included,
   *     rolls back) and it replays the winner.
   * Without a key there is no replay protection.
   */
  async checkout(userId: string, input: CheckoutInput, rawKey?: string | null): Promise<CheckoutResponse> {
    const key = normalizeKey(rawKey);
    const method = input.shippingMethod ?? 'STANDARD';
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new OrderNotFoundError(userId);

    const placement: Placement = {
      userId,
      email: user.email,
      marketingOptIn: user.marketingOptIn,
      source: { cartOf: userId },
      address: input.shippingAddress
        ? { inline: input.shippingAddress, save: input.saveAddress ?? false }
        : { savedId: input.addressId! },
      method,
      guestTokenHash: null,
      actor: 'CUSTOMER',
      promoCode: input.promoCode?.trim() || null,
      billing: billingOf(input),
    };
    if (!key) return this.place(placement, null);

    // The cart is server state (and consumed by the first checkout), so only
    // the client-controlled body is hashed.
    const body =
      (input.shippingAddress
        ? JSON.stringify({ a: normalizeAddress(input.shippingAddress), s: input.saveAddress ?? false, m: method })
        : `${input.addressId}:${method}`) + extrasHash(input);
    const hash = sha256(`${userId}:${body}`);
    const where = { userId, idempotencyKey: key };
    return this.withReplay(where, hash, () => this.place(placement, { key, hash }), true);
  }

  /**
   * Guest checkout (design 05). Idempotency-Key is required: a retried
   * request replays the order instead of charging twice. The returned
   * guestToken reads the order and turns it into an account; only its hash is
   * stored. It is derived from a server secret, the email and the key, so a
   * replay returns the same token.
   */
  async guestCheckout(input: GuestCheckoutInput, rawKey?: string | null) {
    const key = normalizeKey(rawKey);
    if (!key) throw new DomainError(400, 'Idempotency-Key header is required for guest checkout');
    const email = input.email.trim().toLowerCase();
    const method = input.shippingMethod ?? 'STANDARD';
    const items = mergeLines(input.items);
    const token = createHmac('sha256', this.guestTokenSecret).update(`${email}\n${key}`).digest('base64url');

    const hash = sha256(
      JSON.stringify({ email, items, a: normalizeAddress(input.shippingAddress), m: method, o: input.marketingOptIn }) +
        extrasHash(input),
    );
    const result = await this.withReplay(
      { userId: null, customerEmail: email, idempotencyKey: key },
      hash,
      () =>
        this.place(
          {
            userId: null,
            email,
            marketingOptIn: input.marketingOptIn,
            source: { items },
            address: { inline: input.shippingAddress, save: false },
            method,
            guestTokenHash: sha256(token),
            actor: 'GUEST',
            promoCode: input.promoCode?.trim() || null,
            billing: billingOf(input),
          },
          { key, hash },
        ),
      false,
    );
    return { ...result, guestToken: token };
  }

  /** Replay when the key was used; otherwise place, serving the winner if a same-key twin got there first. */
  private async withReplay(
    where: { userId: string | null; idempotencyKey: string; customerEmail?: string },
    hash: string,
    place: () => Promise<CheckoutResponse>,
    cartConsumed: boolean,
  ) {
    const replay = await this.replay(where, hash);
    if (replay) return replay;
    try {
      return await place();
    } catch (e) {
      // Same-key race: lost at the unique index, or (cart checkout) slightly
      // later — the twin committed and consumed the cart first.
      if (isIntegrityViolation(e) || (cartConsumed && e instanceof EmptyCartError)) {
        const winner = await this.replay(where, hash);
        if (winner) return winner;
      }
      throw e;
    }
  }

  /** Signed-in replay (kept for callers of the original API). */
  replayCheckout(userId: string, key: string, hash: string) {
    return this.replay({ userId, idempotencyKey: key }, hash);
  }

  /**
   * Replay for an existing keyed order, or null if none. A still-pending
   * order re-fetches its client secret from the gateway (it is never stored);
   * a terminal one replays without — the client must start a new checkout.
   */
  private async replay(
    where: { userId: string | null; idempotencyKey: string; customerEmail?: string },
    hash: string,
  ): Promise<CheckoutResponse | null> {
    const existing = await this.prisma.order.findFirst({ where: { ...where, deleted: false }, include: ORDER_DETAIL_INCLUDE });
    if (!existing) return null;
    if (existing.requestHash !== hash) throw new IdempotencyKeyConflictError();

    const clientSecret =
      existing.status === 'PENDING_PAYMENT' && existing.paymentIntentId
        ? await this.gateway.findClientSecret(existing.paymentIntentId)
        : null;
    log.info(`Replaying checkout for order ${existing.orderNumber} (idempotency key reuse)`);
    return { order: await this.present(existing), clientSecret };
  }

  /**
   * The one checkout path, signed in or guest. One transaction: validate →
   * snapshot price/name/tax/image → atomically decrement stock (logging the
   * movement) → start payment → persist the order and its first timeline
   * entry → consume the cart. Any failure rolls everything back, so stock is
   * never taken for an order that doesn't exist (NFR-08, FR-IN-02).
   */
  private async place(p: Placement, idem: { key: string; hash: string } | null): Promise<CheckoutResponse> {
    const placed = await this.prisma.$transaction(async (tx) => {
      let requested: CartLineInput[];
      let cartItemIds: string[] = [];
      if ('cartOf' in p.source) {
        const cart = await tx.cart.findFirst({ where: { userId: p.source.cartOf, deleted: false } });
        if (!cart) throw new EmptyCartError();
        const items = await tx.cartItem.findMany({ where: { cartId: cart.id, deleted: false }, orderBy: { createdAt: 'asc' } });
        if (!items.length) throw new EmptyCartError();
        requested = items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
        cartItemIds = items.map((i) => i.id);
      } else {
        requested = p.source.items;
        if (!requested.length) throw new EmptyCartError();
      }

      const address = await this.resolveAddress(tx, p);
      const orderNumber = await generateOrderNumber(tx);

      // A saved address can be a P.O. box too: Express can't go there.
      if (p.method === 'EXPRESS' && isPoBox(address.addressLine1)) {
        throw new ValidationError({ 'shippingAddress.addressLine1': "We can't ship Express to a P.O. box." });
      }

      const bought: { product: CartProduct; quantity: number }[] = [];
      for (const item of requested) {
        const product = await findProduct(tx, item.productId);
        if (!product || product.status !== 'ACTIVE') throw new ProductUnavailableError(item.productId);
        // false: a concurrent buyer took the last units (or there never were enough).
        const taken = await takeStock(tx, product.id, item.quantity, {
          source: 'ORDER',
          reason: `Order ${orderNumber}`,
          actor: p.actor,
        });
        if (!taken) throw new OutOfStockError(product.name);
        bought.push({ product, quantity: item.quantity });
      }

      // The code is checked again here (an invalid one is a 400 on promoCode),
      // with the promotion row locked so a limited code can't be overused.
      const subtotal = bought.reduce((acc, l) => acc.add(l.product.price.mul(l.quantity)), new Prisma.Decimal(0));
      const promo = p.promoCode
        ? await resolvePromotion(tx, p.promoCode, subtotal, { userId: p.userId, email: p.email }, { field: 'promoCode', lock: true })
        : null;
      const priced = priceLines(
        bought.map((l) => ({ unitPrice: l.product.price, quantity: l.quantity, taxRate: l.product.taxRate })),
        p.method,
        this.rules,
        { promo, destination: { state: address.state, postalCode: address.postalCode } },
      );
      const lines: { product: CartProduct; quantity: number; amounts: LineAmounts }[] = bought.map((l, i) => ({
        ...l,
        amounts: priced.lines[i],
      }));
      const totals = priced.totals;
      const savingsTotal = savings(lines.map((l) => ({ unitPrice: l.product.price, mrp: l.product.mrp, quantity: l.quantity })));

      // Manual → PENDING with a generated reference; Stripe → PENDING with a
      // PaymentIntent id and a client secret for the browser to confirm.
      const payment = await this.gateway.initiate({ orderNumber, amount: totals.grandTotal, currency: this.currency });

      const order = await tx.order.create({
        data: {
          userId: p.userId,
          orderNumber,
          status: 'PENDING_PAYMENT',
          currency: this.currency,
          ...totals,
          paymentStatus: payment.status,
          paymentReference: payment.reference,
          // Lets the Stripe webhook reconcile its events back to this order.
          paymentIntentId: payment.reference,
          idempotencyKey: idem?.key ?? null,
          requestHash: idem?.hash ?? null,
          customerEmail: p.email,
          marketingOptIn: p.marketingOptIn,
          guestTokenHash: p.guestTokenHash,
          shippingMethod: p.method,
          shipRecipientName: address.recipientName,
          shipPhone: address.phone,
          shipAddressLine1: address.addressLine1,
          shipAddressLine2: address.addressLine2,
          shipCity: address.city,
          shipState: address.state,
          shipPostalCode: address.postalCode,
          shipCountry: address.country,
          promoCode: promo?.code ?? null,
          promotionId: promo?.id ?? null,
          savingsTotal,
          billSameAsShipping: p.billing.same,
          billAddressLine1: p.billing.addressLine1,
          billPostalCode: p.billing.postalCode,
          items: {
            create: lines.map(({ product, quantity, amounts }) => ({
              mrp: product.mrp && product.mrp.gt(product.price) ? product.mrp : null,
              productId: product.id,
              merchantId: product.merchantId,
              productName: product.name,
              sku: product.sku,
              unitPrice: product.price,
              quantity,
              lineTotal: amounts.subtotal,
              taxCode: product.taxCode,
              taxRate: amounts.taxRate,
              taxAmount: amounts.taxAmount,
              imageUrl: primaryImageUrl(product.images),
              variantName: product.variantName,
              color: product.color,
              size: product.size,
            })),
          },
        },
      });
      await recordOrderEvent(tx, order.id, { status: 'PENDING_PAYMENT', note: 'Order placed', actor: p.actor });

      // The order consumed the cart.
      if (cartItemIds.length) {
        await tx.cartItem.updateMany({ where: { id: { in: cartItemIds } }, data: { deleted: true } });
      }
      return { orderId: order.id, clientSecret: payment.clientSecret };
    }, TX.checkout);

    const order = await this.loadDetail(this.prisma, placed.orderId);
    await this.mailer.send(orderPlacedMail(order, this.mail));
    // The client secret goes back to the client but is never stored.
    return { order: await this.present(order), clientSecret: placed.clientSecret };
  }

  private async resolveAddress(tx: Db, p: Placement): Promise<AddressSnapshot> {
    if ('savedId' in p.address) {
      if (!p.userId) throw new AddressNotFoundError(p.address.savedId);
      const saved = await tx.userAddress.findFirst({ where: { id: p.address.savedId, userId: p.userId, deleted: false } });
      if (!saved) throw new AddressNotFoundError(p.address.savedId);
      return saved;
    }
    const address = normalizeAddress(p.address.inline);
    if (p.address.save && p.userId) await saveCheckoutAddress(tx, p.userId, address, this.maxAddresses);
    return address;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async findMyOrders(userId: string, pageable: Pageable, query: OrderListQuery = {}) {
    const where = orderListWhere(userId, query);
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_SUMMARY_INCLUDE,
        orderBy: orderBy(pageable, [{ createdAt: 'desc' }]),
        ...skipTake(pageable),
      }),
      this.prisma.order.count({ where }),
    ]);
    const refs = await productRefs(this.prisma, rows.flatMap((o) => o.items.map((i) => i.productId)));
    return toPage(
      rows.map((o) => toOrderSummaryResponse(o, this.view, refs)),
      total,
      pageable,
    );
  }

  /** Tab counts for the account order list, under the same search and period. */
  async countMyOrders(userId: string, query: Omit<OrderListQuery, 'status'> = {}) {
    const count = (status?: OrderListFilter) => this.prisma.order.count({ where: orderListWhere(userId, { ...query, status }) });
    const [all, open, delivered, returned, cancelled] = await Promise.all([
      count(),
      count('open'),
      count('delivered'),
      count('returned'),
      count('cancelled'),
    ]);
    return { all, open, delivered, returned, cancelled };
  }

  /** "Email invoice": the order's invoice, sent to the order's email (a logged notification). */
  async emailInvoice(user: { id: string; email: string }, idOrNumber: string) {
    const order = await findOwned(this.prisma, user.id, idOrNumber);
    const c = order.currency;
    const lines = order.items.map(
      (i) => `${i.quantity} × ${i.productName}${i.variantName ? ` (${i.variantName})` : ''} — ${i.lineTotal.toFixed(2)} ${c}`,
    );
    await this.mailer.send({
      template: 'ORDER_INVOICE',
      to: order.customerEmail ?? user.email,
      subject: `Invoice for order ${order.orderNumber}`,
      body: [
        `Invoice for order ${order.orderNumber} (placed ${order.createdAt.toISOString().slice(0, 10)})`,
        '',
        ...lines,
        '',
        `Subtotal: ${order.subtotal.toFixed(2)} ${c}`,
        ...(order.discountTotal.gt(0) ? [`Discount: -${order.discountTotal.toFixed(2)} ${c}`] : []),
        `Shipping: ${order.shippingTotal.toFixed(2)} ${c}`,
        `Tax: ${order.taxTotal.toFixed(2)} ${c}`,
        `Total: ${order.grandTotal.toFixed(2)} ${c}`,
        ...(order.refundedTotal.gt(0) ? [`Refunded: ${order.refundedTotal.toFixed(2)} ${c}`] : []),
        '',
        `Ship to: ${order.shipRecipientName}, ${order.shipAddressLine1}, ${order.shipCity}, ${order.shipState} ${order.shipPostalCode}`,
        '',
        this.mail.storeName,
      ].join('\n'),
      orderId: order.id,
      userId: user.id,
    });
  }

  /** By id or order number (EC-1234567, typed any way). */
  async findById(userId: string, idOrNumber: string) {
    return this.present(await findOwned(this.prisma, userId, idOrNumber));
  }

  /** A guest's order, read with the token returned at checkout. */
  async findGuestOrder(orderNumber: string, token: string | undefined) {
    if (!token) throw new OrderNotFoundError(orderNumber);
    const order = await this.prisma.order.findFirst({
      where: { orderNumber: normalizeOrderNumber(orderNumber), guestTokenHash: sha256(token), deleted: false },
      include: ORDER_DETAIL_INCLUDE,
    });
    if (!order) throw new OrderNotFoundError(orderNumber);
    return this.present(order);
  }

  /**
   * Public tracking (FR-ST-12, FR-IN-04): order number plus the order's email
   * (any case) or 5-digit ZIP. Every miss is the same 404, so the form can't
   * be used to learn which part was wrong.
   */
  async track(input: z.output<typeof TrackOrderSchema>) {
    const order = await this.prisma.order.findFirst({
      where: { orderNumber: normalizeOrderNumber(input.orderNumber), deleted: false },
      include: { ...ORDER_DETAIL_INCLUDE, user: { select: { email: true } } },
    });
    if (!order) throw new TrackedOrderNotFoundError();
    const given = input.emailOrZip.trim();
    // A ZIP matches the shipping ZIP or, when billing differed, the billing ZIP.
    const zips = [order.shipPostalCode, order.billPostalCode].filter((z): z is string => !!z).map(postalCode5);
    const matches = given.includes('@')
      ? [order.customerEmail, order.user?.email].some((e) => !!e && e.toLowerCase() === given.toLowerCase())
      : /^\d{5}(-?\d{4})?$/.test(given) && zips.includes(given.slice(0, 5));
    if (!matches) throw new TrackedOrderNotFoundError();
    return toTrackedOrder(order, this.view);
  }

  // ── Returns (FR-AD-07, customer side) ────────────────────────────────────

  /**
   * A return request for a delivered order inside the return window. Each
   * line can return at most what was bought minus what is already returned or
   * in an open request; the order row is locked so two requests can't both
   * claim the same units.
   */
  async requestReturn(userId: string, idOrNumber: string, input: z.output<typeof ReturnRequestSchema>) {
    const pickup = input.method === 'PICKUP' ? pickupDay(input.pickupDate) : null;
    const created = await this.prisma.$transaction(async (tx) => {
      const { id } = await findOwned(tx, userId, idOrNumber);
      await lockOrderRow(tx, id);
      const order = await tx.order.findFirstOrThrow({
        where: { id },
        include: { ...ORDER_ITEMS_INCLUDE, returns: { where: { status: { in: LIVE_RETURN_STATUSES } }, include: { items: true } } },
      });
      if (order.status !== 'DELIVERED') {
        throw new InvalidOrderStateError('Only delivered orders can be returned');
      }
      const until = returnableUntil(order, this.view);
      if (!until || until.getTime() < Date.now()) {
        throw new InvalidOrderStateError(`The ${this.view.returnWindowDays}-day return window for this order has closed`);
      }

      const seen = new Set<string>();
      for (const [index, line] of input.items.entries()) {
        const item = order.items.find((i) => i.id === line.orderItemId);
        if (!item) throw new DomainError(400, `Item ${line.orderItemId} is not part of order ${order.orderNumber}`);
        if (seen.has(item.id)) throw new DomainError(400, `items[${index}]: each item can appear only once`);
        seen.add(item.id);
        const requested = order.returns
          .flatMap((r) => r.items)
          .filter((ri) => ri.orderItemId === item.id)
          .reduce((n, ri) => n + ri.quantity, 0);
        const left = item.quantity - Math.max(item.returnedQuantity, requested);
        if (line.quantity > left) {
          throw new DomainError(
            400,
            left > 0
              ? `Only ${left} of '${item.productName}' can still be returned`
              : `'${item.productName}' has already been returned`,
          );
        }
      }

      const rmaNumber = await generateRmaNumber(tx);
      const ret = await tx.orderReturn.create({
        data: {
          orderId: order.id,
          rmaNumber,
          status: 'REQUESTED',
          reason: input.reason,
          method: input.method ?? null,
          requestedBy: 'CUSTOMER',
          refundTo: input.refundTo ?? 'ORIGINAL',
          dropoffCode: dropoffCode(rmaNumber),
          dropoffBy: new Date(Date.now() + DROPOFF_DAYS * DAY_MS),
          pickupDate: pickup,
          pickupWindow: pickup ? PICKUP_WINDOW : null,
          items: { create: input.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) },
        },
        include: { items: true },
      });
      await recordOrderEvent(tx, order.id, { status: order.status, note: `Return ${rmaNumber} requested`, actor: 'CUSTOMER' });
      return { order, ret };
    }, TX.default);

    await this.mailer.send(returnRequestedMail(created.order, this.mail, created.ret.rmaNumber));
    return toReturnResponse(created.ret, created.order.items, this.view, created.order);
  }

  // ── Cancellation and manual payment ──────────────────────────────────────

  /**
   * Customer cancellation of an unshipped order (PENDING_PAYMENT, PAID,
   * CONFIRMED). Every transition goes through an atomic claim shared with the
   * webhook and expiry paths, so a concurrent cancellation can never restock
   * twice; a lost claim re-reads and reports the settled order.
   *  - A paid order is refunded through the gateway first; if that fails,
   *    nothing changes.
   *  - An unpaid order's PaymentIntent is cancelled first so it can't be paid
   *    afterwards; if the payment is mid-flight the cancel is refused.
   */
  async cancel(userId: string, idOrNumber: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const order = await findOwned(tx, userId, idOrNumber);
      const cancellable: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'CONFIRMED'];
      if (!cancellable.includes(order.status as OrderStatus)) {
        throw new InvalidOrderStateError(`An order with status ${order.status} can no longer be cancelled`);
      }

      let claimed: number;
      const refunding = order.status !== 'PENDING_PAYMENT';
      if (!refunding) {
        if (order.paymentIntentId && !(await this.gateway.cancelPayment(order.paymentIntentId))) {
          throw new InvalidOrderStateError(
            'Payment for this order is completing — wait for the result, then cancel or refund',
          );
        }
        claimed = await claimPendingCancellation(tx, order.id, 'Cancelled by customer', 'CUSTOMER');
      } else {
        // The gateway refund is idempotent (keyed on the intent): if the claim
        // is then lost to the charge.refunded webhook, nothing happens twice.
        const refundRef = await this.gateway.refund(order.paymentIntentId!, order.grandTotal, order.currency);
        log.info(`Refund ${refundRef} issued for order ${order.orderNumber}`);
        claimed = await claimRefundCancellation(tx, order.id, 'Cancelled by customer', 'CUSTOMER');
      }
      if (claimed === 1) {
        await restock(tx, order.items, { source: 'CANCELLATION', reason: `Order ${order.orderNumber} cancelled by customer`, actor: 'CUSTOMER' });
        await recordOrderEvent(tx, order.id, {
          status: 'CANCELLED',
          note: refunding ? 'Cancelled by customer; payment refunded' : 'Cancelled by customer',
          actor: 'CUSTOMER',
        });
      }

      const settled = await this.loadDetail(tx, order.id);
      if (settled.status !== 'CANCELLED') {
        // Lost the claim to a payment that completed concurrently.
        throw new InvalidOrderStateError(`An order with status ${settled.status} can no longer be cancelled`);
      }
      return { settled, claimed: claimed === 1, refunding };
    }, TX.checkout);

    if (outcome.claimed) await this.mailer.send(orderCancelledMail(outcome.settled, this.mail, outcome.refunding));
    return this.present(outcome.settled);
  }

  /**
   * Admin payment confirmation — the manual gateway's stand-in for a webhook.
   * Disabled for real providers: the order would read PAID with no money moved.
   */
  async markPaid(orderId: string, actor = 'ADMIN') {
    if (!this.gateway.supportsManualConfirmation()) {
      throw new InvalidOrderStateError('Manual payment confirmation is disabled for the active payment provider');
    }
    const order = await this.prisma.order.findFirst({ where: { id: orderId, deleted: false } });
    if (!order) throw new OrderNotFoundError(orderId);

    const claimed = await this.prisma.$transaction(async (tx) => {
      if ((await claimPaid(tx, orderId)) === 0) return false;
      await recordOrderEvent(tx, orderId, {
        status: 'PAID',
        fulfilmentStatus: 'UNFULFILLED',
        note: 'Payment confirmed manually',
        actor,
      });
      return true;
    }, TX.default);
    if (!claimed) {
      const current = await this.prisma.order.findFirst({ where: { id: orderId, deleted: false } });
      if (!current) throw new OrderNotFoundError(orderId);
      throw new InvalidOrderStateError(
        `Only a PENDING_PAYMENT order can be marked paid (current: ${current.status})`,
      );
    }
    const paid = await this.afterPaid(orderId);
    return this.present(paid, { customerView: false });
  }

  /** Paid-side effects, once per order (the claim's winner): email and the PURCHASE event. */
  private async afterPaid(orderId: string) {
    await this.snapshotPaymentMethod(orderId);
    const order = await this.loadDetail(this.prisma, orderId);
    await this.mailer.send(paymentReceivedMail(order, this.mail));
    await this.analytics.recordPurchase(
      order,
      order.items.reduce((n, i) => n + i.quantity, 0),
    );
    return order;
  }

  // ── PaymentEventHandler (verified gateway events) ────────────────────────

  /**
   * Validates the captured amount and currency before marking PAID: a mismatch
   * throws, so the webhook event is stored FAILED (replayable) instead of
   * confirming a wrong amount.
   */
  async confirmPaymentByIntent(paymentIntentId: string, amountMinor: bigint, reportedCurrency: string) {
    const order = await this.byIntent(paymentIntentId);
    if (!order) {
      log.warn(`Payment succeeded for unknown intent ${paymentIntentId} — ignoring`);
      return;
    }
    if (order.status === 'PAID') return; // an earlier delivery already reconciled it
    if (order.status !== 'PENDING_PAYMENT') {
      // e.g. CANCELLED: the customer paid for an order we no longer honour.
      log.error(
        `Payment succeeded for order ${order.orderNumber} in unexpected state ${order.status} — manual review required`,
      );
      return;
    }
    const expected = toMinorUnits(order.grandTotal, order.currency);
    if (expected !== amountMinor || order.currency.toLowerCase() !== reportedCurrency.toLowerCase()) {
      throw new PaymentAmountMismatchError(order.orderNumber, expected, amountMinor, order.currency, reportedCurrency);
    }
    const claimed = await this.prisma.$transaction(async (tx) => {
      if ((await claimPaid(tx, order.id)) === 0) return false;
      await recordOrderEvent(tx, order.id, {
        status: 'PAID',
        fulfilmentStatus: 'UNFULFILLED',
        note: 'Payment received',
        actor: 'GATEWAY',
      });
      return true;
    }, TX.default);
    if (claimed) await this.afterPaid(order.id);
  }

  /**
   * Records the failed attempt only: a decline is not terminal (the customer
   * can retry the same intent). Abandoned orders are released by the expiry job.
   */
  async recordPaymentFailureByIntent(paymentIntentId: string) {
    const order = await this.byIntent(paymentIntentId);
    if (!order) {
      log.warn(`Payment failed for unknown intent ${paymentIntentId} — ignoring`);
      return;
    }
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        lastPaymentFailureAt: new Date(),
        ...(order.status === 'PENDING_PAYMENT' ? { paymentStatus: 'FAILED' } : {}),
      },
    });
    log.info(`Recorded failed payment attempt for order ${order.orderNumber}`);
  }

  async cancelPaymentByIntent(paymentIntentId: string) {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const order = await this.byIntent(paymentIntentId, tx);
      if (!order) {
        log.warn(`Payment cancelled for unknown intent ${paymentIntentId} — ignoring`);
        return null;
      }
      // Already cancelled (the expiry job's own cancel echoing back, or the customer path).
      if (order.status !== 'PENDING_PAYMENT') return null;

      if ((await claimPendingCancellation(tx, order.id, 'Payment cancelled at the provider', 'GATEWAY')) === 1) {
        await restock(tx, order.items, { source: 'CANCELLATION', reason: `Order ${order.orderNumber}: payment cancelled`, actor: 'GATEWAY' });
        await recordOrderEvent(tx, order.id, { status: 'CANCELLED', note: 'Payment cancelled at the provider', actor: 'GATEWAY' });
        log.info(`Order ${order.orderNumber} cancelled after its PaymentIntent was cancelled at the provider`);
        return order;
      }
      return null;
    }, TX.default);
    if (cancelled) await this.mailer.send(orderCancelledMail(cancelled, this.mail, false));
  }

  /**
   * The source of truth for refunds (`amountRefundedMinor` is cumulative).
   * Refunds we issued (cancellations, returns) are already in refunded_total,
   * so their echo is a no-op; money refunded elsewhere is recorded — a full
   * refund of an unshipped order cancels and restocks through the claim shared
   * with cancel-with-refund, anything else raises refunded_total
   * (src/admin/refund-reconciliation.ts).
   */
  recordRefundByIntent(paymentIntentId: string, amountRefundedMinor: bigint, _currency: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.byIntent(paymentIntentId, tx);
      if (!order) {
        log.warn(`Refund reported for unknown intent ${paymentIntentId} — ignoring`);
        return;
      }
      await reconcileProviderRefund(tx, order, amountRefundedMinor);
    }, TX.default);
  }

  private byIntent(paymentIntentId: string, db: Db = this.prisma) {
    return db.order.findFirst({ where: { paymentIntentId, deleted: false }, include: ORDER_ITEMS_INCLUDE });
  }

  // ── Presentation ─────────────────────────────────────────────────────────

  private loadDetail(db: Db, orderId: string) {
    return db.order.findFirstOrThrow({ where: { id: orderId }, include: ORDER_DETAIL_INCLUDE });
  }

  /** The full `Order`, with each line's parent product for PDP links. */
  async present(order: OrderDetail, options: { customerView?: boolean } = {}) {
    const refs = await productRefs(this.prisma, order.items.map((i) => i.productId));
    return toOrderResponse(order, this.view, {
      customerView: options.customerView ?? true,
      parentIds: new Map([...refs].map(([id, r]) => [id, r.parentId])),
      slugs: new Map([...refs].map(([id, r]) => [id, r.slug])),
    });
  }

  /**
   * "Visa •••• 4242" on the order (contract B3): what the gateway reports for
   * the paid intent (MANUAL for the manual gateway). Best effort — a lookup
   * failure never undoes the payment.
   */
  private async snapshotPaymentMethod(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { paymentIntentId: true } });
    if (!order?.paymentIntentId || !this.gateway.describePayment) return;
    try {
      const method = await this.gateway.describePayment(order.paymentIntentId);
      if (!method) return;
      await this.prisma.order.update({
        where: { id: orderId },
        data: { paymentMethodType: method.type, cardBrand: method.brand, cardLast4: method.last4 },
      });
    } catch (e) {
      log.warn(`Could not read the payment method for order ${orderId}`, e);
    }
  }
}

/** Parent id and PDP slug (url slug, else the SKU id) of the products order lines point at. */
export async function productRefs(db: Db, productIds: string[]): Promise<Map<string, { parentId: string; slug: string }>> {
  if (!productIds.length) return new Map();
  const rows = await db.product.findMany({
    where: { id: { in: [...new Set(productIds)] } },
    select: { id: true, parentId: true, urlSlug: true },
  });
  return new Map(rows.map((p) => [p.id, { parentId: p.parentId, slug: p.urlSlug ?? p.id }]));
}

function findProduct(db: Db, productId: string) {
  return db.product.findFirst({ where: { id: productId, deleted: false }, include: CART_PRODUCT_INCLUDE });
}

/** The caller's order by id or order number; anyone else's is a 404. */
async function findOwned(db: Db, userId: string, idOrNumber: string): Promise<OrderDetail> {
  const order = await db.order.findFirst({
    where: { ...orderKey(idOrNumber), userId, deleted: false },
    include: ORDER_DETAIL_INCLUDE,
  });
  if (!order) throw new OrderNotFoundError(idOrNumber);
  return order;
}

export function orderKey(idOrNumber: string) {
  const v = idOrNumber.trim();
  return isUuid(v) ? { id: v.toLowerCase() } : { orderNumber: normalizeOrderNumber(v) };
}

function normalizeKey(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const key = raw.trim();
  if (!KEY_PATTERN.test(key)) throw new InvalidIdempotencyKeyError();
  return key;
}

function normalizeAddress(a: ShippingAddressInput): AddressSnapshot {
  return {
    recipientName: a.recipientName.trim(),
    phone: a.phone?.trim() || null,
    addressLine1: a.addressLine1.trim(),
    addressLine2: a.addressLine2?.trim() || null,
    city: a.city.trim(),
    state: normalizeState(a.state, a.country),
    postalCode: a.postalCode.trim(),
    country: a.country?.trim() || 'US',
  };
}

/** Same product twice counts once, quantities added; sorted so the request hash is stable. */
function mergeLines(items: CartLineInput[]): CartLineInput[] {
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.quantity);
  return [...merged]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productId, quantity]) => ({ productId, quantity }));
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type { OrderWithItems };
