import express, { Router } from 'express';
import { assertRole, currentUser, requireAuth, requireRole } from './auth/auth.middleware';
import { clientInfo } from './account/account-settings.routes';
import {
  LoginSchema,
  LoginVerifySchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
  RegisterSchema,
} from './auth/auth.service';
import {
  CartItemSchema,
  CartItemUpdateSchema,
  CartLinesBodySchema,
  CartPreviewSchema,
  PromoValidateSchema,
} from './cart/cart.service';
import { created, noContent, ok } from './common/api-response';
import { SellerReviewRequiredError } from './common/errors';
import { ORDER_STATUSES } from './common/enums';
import { parsePageable } from './common/pagination';
import { parseBody, pathUuid, ValidationError } from './common/validation';
import type { Container } from './container';
import { storeConfig } from './store/store-config';
import { CheckoutSchema, ORDER_SORTS, parseOrderListQuery, ReturnRequestSchema } from './order/order.service';
import { CategoryCreateSchema } from './product/category.service';
import { PRODUCT_SORTS, ProductCreateSchema, ProductUpdateSchema } from './product/product.service';
import { AddressSchema } from './user/address.service';

// Route guards follow the Java security config: /api/auth, /api/products,
// /api/categories, /api/store and the Stripe webhook are public paths (role
// checks there answer 403); every other /api path needs a token first (401).
// Where a route takes a body, it is validated before the role check (Spring's order).

/**
 * FR-AD-08: catalog staff manage products, variants, inventory, images,
 * categories and catalog files; orders, returns, customers, users, analytics,
 * reports and settings stay with admins.
 */
export const CATALOG_ROLES = ['ROLE_ADMIN', 'ROLE_CATALOG'] as const;

/** Admins and catalog staff see unpublished products on the public product routes. */
const isCatalogStaff = (user: { role: string } | undefined) =>
  user !== undefined && (CATALOG_ROLES as readonly string[]).includes(user.role);

export function authRoutes(c: Container): Router {
  const r = Router();
  r.post('/register', async (req, res) => {
    const data = await c.auth.register(parseBody(RegisterSchema, req.body), clientInfo(req));
    res.status(201).json(created(data, 'Account registered successfully'));
  });
  r.post('/login', async (req, res) => {
    const data = await c.auth.login(parseBody(LoginSchema, req.body), clientInfo(req));
    res.json(ok(data, 'twoFactorRequired' in data ? 'Enter the code we texted you' : 'Login successful'));
  });
  /** Step two when TWO_FACTOR_ENFORCE=true. */
  r.post('/login/verify', async (req, res) => {
    res.json(ok(await c.auth.verifyLogin(parseBody(LoginVerifySchema, req.body), clientInfo(req)), 'Login successful'));
  });
  /** Signs this device out: its session stops working. */
  r.post('/logout', requireAuth, async (req, res) => {
    await c.auth.logout(currentUser(req), req.sessionId);
    res.json(noContent('Signed out'));
  });
  /** Always the same answer, so it never reveals whether an account exists. */
  r.post('/password-reset/request', async (req, res) => {
    await c.auth.requestPasswordReset(parseBody(PasswordResetRequestSchema, req.body));
    res.json(noContent('If an account exists for that email, a reset link is on its way'));
  });
  r.post('/password-reset/confirm', async (req, res) => {
    const data = await c.auth.confirmPasswordReset(parseBody(PasswordResetConfirmSchema, req.body), clientInfo(req));
    res.json(ok(data, 'Password updated'));
  });
  return r;
}

export function categoryRoutes(c: Container): Router {
  const r = Router();
  r.get('/', async (_req, res) => {
    res.json(ok(await c.categories.findAll()));
  });
  // Before '/:id', or "tree" would be taken for an id.
  r.get('/tree', async (_req, res) => {
    res.json(ok(await c.categories.tree()));
  });
  r.get('/:id', async (req, res) => {
    res.json(ok(await c.categories.findById(pathUuid(req.params.id))));
  });
  r.post('/', async (req, res) => {
    const input = parseBody(CategoryCreateSchema, req.body);
    assertRole(req, ...CATALOG_ROLES);
    const data = await c.categories.create(input);
    res.status(201).json(created(data, 'Category created successfully'));
  });
  return r;
}

export function productRoutes(c: Container): Router {
  const r = Router();
  const pageable = (req: express.Request) =>
    parsePageable(req, { sort: 'createdAt', allowedSorts: PRODUCT_SORTS });

  r.get('/', async (req, res) => {
    res.json(ok(await c.products.findAllActive(pageable(req))));
  });
  // Before '/:id', or "my" would be taken for an id.
  r.get('/my', requireRole('ROLE_MERCHANT'), async (req, res) => {
    res.json(ok(await c.products.findByMerchant(currentUser(req).id, pageable(req))));
  });
  r.get('/slug/:slug', async (req, res) => {
    const user = req.user;
    const slug = String(req.params.slug).trim().toLowerCase();
    res.json(ok(await c.products.findBySlug(slug, user?.id ?? null, isCatalogStaff(user))));
  });
  r.get('/category/:categoryId', async (req, res) => {
    res.json(ok(await c.products.findByCategory(pathUuid(req.params.categoryId, 'categoryId'), pageable(req))));
  });
  r.get('/:id', async (req, res) => {
    const user = req.user;
    res.json(ok(await c.products.findById(pathUuid(req.params.id), user?.id ?? null, isCatalogStaff(user))));
  });
  // Seller portal: sellers no longer write here; every change goes through
  // review at /api/seller/submissions. Validation and the role check keep
  // their Spring order, so other callers get the answers they always did.
  r.post('/', async (req, res) => {
    parseBody(ProductCreateSchema, req.body);
    assertRole(req, 'ROLE_MERCHANT');
    throw new SellerReviewRequiredError();
  });
  r.put('/:id', async (req) => {
    pathUuid(req.params.id);
    parseBody(ProductUpdateSchema, req.body);
    assertRole(req, 'ROLE_MERCHANT');
    throw new SellerReviewRequiredError();
  });
  r.delete('/:id', requireRole('ROLE_MERCHANT'), async () => {
    throw new SellerReviewRequiredError();
  });
  return r;
}

export function addressRoutes(c: Container): Router {
  const r = Router();
  r.use(requireAuth);
  r.post('/', async (req, res) => {
    const data = await c.addresses.create(currentUser(req).id, parseBody(AddressSchema, req.body));
    res.status(201).json(created(data, 'Address added successfully'));
  });
  r.get('/', async (req, res) => {
    res.json(ok(await c.addresses.findAll(currentUser(req).id), 'Addresses retrieved'));
  });
  r.get('/:id', async (req, res) => {
    res.json(ok(await c.addresses.findById(currentUser(req).id, pathUuid(req.params.id))));
  });
  r.put('/:id', async (req, res) => {
    const data = await c.addresses.update(currentUser(req).id, pathUuid(req.params.id), parseBody(AddressSchema, req.body));
    res.json(ok(data, 'Address updated successfully'));
  });
  r.delete('/:id', async (req, res) => {
    await c.addresses.delete(currentUser(req).id, pathUuid(req.params.id));
    res.json(noContent('Address removed successfully'));
  });
  r.patch('/:id/default', async (req, res) => {
    res.json(ok(await c.addresses.setDefault(currentUser(req).id, pathUuid(req.params.id)), 'Default address updated'));
  });
  return r;
}

export function cartRoutes(c: Container): Router {
  const r = Router();
  /** Public: prices a guest's browser cart (FR-ST-09). */
  r.post('/preview', async (req, res) => {
    const input = parseBody(CartPreviewSchema, req.body);
    const userId = req.user?.role === 'ROLE_CUSTOMER' ? req.user.id : null;
    const data = await c.cart.preview(input.items, {
      promoCode: input.promoCode,
      customer: { userId, email: input.email },
      destination: input.shippingAddress,
    });
    res.json(ok(data));
  });
  /** Public: checks a promo code against the given lines (or the signed-in cart); 400 on `code`. */
  r.post('/promo/validate', async (req, res) => {
    const input = parseBody(PromoValidateSchema, req.body);
    const userId = req.user?.role === 'ROLE_CUSTOMER' ? req.user.id : null;
    res.json(ok(await c.cart.validatePromo(input.code, input.items, { userId, email: input.email }), 'Promo code applied'));
  });
  r.use(requireAuth);
  const customer = requireRole('ROLE_CUSTOMER');
  /** After sign-in: the guest's lines join the account cart (capped at stock). */
  r.post('/merge', async (req, res) => {
    const { items } = parseBody(CartLinesBodySchema, req.body);
    res.json(ok(await c.cart.merge(assertRole(req, 'ROLE_CUSTOMER').id, items), 'Cart merged'));
  });
  r.get('/', customer, async (req, res) => {
    const q = (name: string) => (typeof req.query[name] === 'string' && req.query[name] ? String(req.query[name]).slice(0, 100) : undefined);
    const promoCode = q('promoCode');
    const state = q('state');
    res.json(ok(await c.cart.getCart(currentUser(req).id, { promoCode, destination: state ? { state, postalCode: q('postalCode') } : null })));
  });
  r.post('/items', async (req, res) => {
    const input = parseBody(CartItemSchema, req.body);
    res.json(ok(await c.cart.addItem(assertRole(req, 'ROLE_CUSTOMER').id, input), 'Item added to cart'));
  });
  r.put('/items/:productId', async (req, res) => {
    const productId = pathUuid(req.params.productId, 'productId');
    const { quantity } = parseBody(CartItemUpdateSchema, req.body);
    const data = await c.cart.updateItem(assertRole(req, 'ROLE_CUSTOMER').id, productId, quantity);
    res.json(ok(data, 'Cart item updated'));
  });
  r.delete('/items/:productId', customer, async (req, res) => {
    await c.cart.removeItem(currentUser(req).id, pathUuid(req.params.productId, 'productId'));
    res.json(noContent('Item removed from cart'));
  });
  r.delete('/', customer, async (req, res) => {
    await c.cart.clearCart(currentUser(req).id);
    res.json(noContent('Cart cleared'));
  });
  return r;
}

export function orderRoutes(c: Container): Router {
  const r = Router();
  r.use(requireAuth);
  const customer = requireRole('ROLE_CUSTOMER');

  /** Idempotency-Key makes the call replay-safe: a retry returns the same order. */
  r.post('/', async (req, res) => {
    const input = parseBody(CheckoutSchema, req.body);
    const user = assertRole(req, 'ROLE_CUSTOMER');
    const data = await c.orders.checkout(user.id, input, req.header('Idempotency-Key'));
    res.status(201).json(created(data, 'Order placed successfully'));
  });
  /** ?status=open|delivered|returned|cancelled|done &q= (order number or item name) &period=30d|3m|6m|YYYY */
  r.get('/', customer, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'createdAt,desc', allowedSorts: ORDER_SORTS });
    res.json(ok(await c.orders.findMyOrders(currentUser(req).id, pageable, parseOrderListQuery(req.query))));
  });
  // Before '/:id', or "counts" would be taken for an order number.
  r.get('/counts', customer, async (req, res) => {
    const { q, period } = parseOrderListQuery({ q: req.query.q, period: req.query.period });
    res.json(ok(await c.orders.countMyOrders(currentUser(req).id, { q, period })));
  });
  r.post('/:id/invoice/email', customer, async (req, res) => {
    await c.orders.emailInvoice(currentUser(req), orderRef(req.params.id));
    res.status(202).json(noContent('Invoice sent'));
  });
  // ':id' is the order id or its number (EC-1234567).
  r.get('/:id', customer, async (req, res) => {
    res.json(ok(await c.orders.findById(currentUser(req).id, orderRef(req.params.id))));
  });
  r.post('/:id/cancel', customer, async (req, res) => {
    res.json(ok(await c.orders.cancel(currentUser(req).id, orderRef(req.params.id)), 'Order cancelled'));
  });
  /** FR-AD-07: a return request for a delivered order. */
  r.post('/:id/returns', async (req, res) => {
    const input = parseBody(ReturnRequestSchema, req.body);
    const user = assertRole(req, 'ROLE_CUSTOMER');
    const data = await c.orders.requestReturn(user.id, orderRef(req.params.id), input);
    res.status(201).json(created(data, 'Return requested'));
  });
  /** Admin stand-in for a provider callback under the manual gateway: PENDING_PAYMENT → PAID. */
  r.post('/:id/pay', requireRole('ROLE_ADMIN'), async (req, res) => {
    res.json(ok(await c.orders.markPaid(pathUuid(req.params.id)), 'Order marked as paid'));
  });
  return r;
}

/** An order id or number from the path; anything longer than either is a 400. */
function orderRef(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 60) {
    throw new ValidationError({ id: 'must be an order id or order number' });
  }
  return value;
}

/** Mounted only when PAYMENT_PROVIDER=stripe. */
export function stripeRoutes(c: Container): Router {
  const r = Router();
  const webhook = c.stripeWebhook!;
  // Public: Stripe sends no JWT; authenticity is the Stripe-Signature over the raw body.
  r.post('/webhook', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    await webhook.process(body, req.header('Stripe-Signature'));
    res.json(noContent('Webhook processed'));
  });
  /** Admin recovery: re-dispatch a stored FAILED event once its cause is fixed. */
  r.post('/webhook-events/:eventId/replay', requireAuth, requireRole('ROLE_ADMIN'), async (req, res) => {
    await webhook.replay(String(req.params.eventId));
    res.json(noContent('Webhook event re-dispatched'));
  });
  return r;
}

/** Public storefront settings (shipping methods, tax mode, payment provider). */
export function storeRoutes(c: Container): Router {
  const r = Router();
  r.get('/config', (_req, res) => {
    res.json(ok(storeConfig(c.config)));
  });
  return r;
}
