import { Router } from 'express';
import { AnalyticsBatchSchema } from './analytics/analytics.service';
import { currentUser, requireAuth } from './auth/auth.middleware';
import { OrderAccountSchema } from './auth/auth.service';
import { created, ok } from './common/api-response';
import { parseBody } from './common/validation';
import type { Container } from './container';
import { GuestCheckoutSchema, QuoteSchema, TrackOrderSchema } from './order/order.service';
import { SellerApplicationSchema, SupportMessageSchema } from './support/support.service';
import { PasswordChangeSchema, ProfileUpdateSchema } from './user/account.service';

// Storefront routes added with guest checkout: all public except the account
// routes. Rate limiting for tracking is in src/auth/rate-limit.ts.

/** Checkout without an account (FR-ST-10/11), the quote, and a guest's order. */
export function checkoutRoutes(c: Container): Router {
  const r = Router();

  /** Guests send their lines; a signed-in customer may send none to quote the server cart. */
  r.post('/quote', async (req, res) => {
    const input = parseBody(QuoteSchema, req.body);
    const customerId = req.user?.role === 'ROLE_CUSTOMER' ? req.user.id : null;
    res.json(ok(await c.cart.quote(input.items, customerId, input.shippingMethod)));
  });

  /** Idempotency-Key is required: a retry returns the same order (and token). */
  r.post('/guest', async (req, res) => {
    const input = parseBody(GuestCheckoutSchema, req.body);
    const data = await c.orders.guestCheckout(input, req.header('Idempotency-Key'));
    res.status(201).json(created(data, 'Order placed successfully'));
  });

  r.get('/orders/:orderNumber', async (req, res) => {
    res.json(ok(await c.orders.findGuestOrder(String(req.params.orderNumber), req.header('X-Order-Token'))));
  });

  r.post('/orders/:orderNumber/account', async (req, res) => {
    const input = parseBody(OrderAccountSchema, req.body);
    const data = await c.auth.createAccountFromGuestOrder(String(req.params.orderNumber), req.header('X-Order-Token'), input);
    res.status(201).json(created(data, 'Account created'));
  });
  return r;
}

/** POST /api/orders/track — public tracking by order number + email or ZIP (FR-ST-12, FR-IN-04). */
export function trackRoutes(c: Container): Router {
  const r = Router();
  r.post('/', async (req, res) => {
    res.json(ok(await c.orders.track(parseBody(TrackOrderSchema, req.body))));
  });
  return r;
}

/** /api/users/me — the signed-in user's profile and password. */
export function accountRoutes(c: Container): Router {
  const r = Router();
  r.use(requireAuth);
  r.get('/', async (req, res) => {
    res.json(ok(await c.accounts.getProfile(currentUser(req))));
  });
  r.patch('/', async (req, res) => {
    const input = parseBody(ProfileUpdateSchema, req.body);
    res.json(ok(await c.accounts.updateProfile(currentUser(req), input), 'Profile updated'));
  });
  r.post('/password', async (req, res) => {
    const input = parseBody(PasswordChangeSchema, req.body);
    res.json(ok(await c.accounts.changePassword(currentUser(req), input), 'Password changed'));
  });
  return r;
}

/** POST /api/support/messages — help center contact form. */
export function supportRoutes(c: Container): Router {
  const r = Router();
  r.post('/messages', async (req, res) => {
    const data = await c.support.createMessage(parseBody(SupportMessageSchema, req.body));
    res.status(201).json(created(data, 'Message received'));
  });
  return r;
}

/** POST /api/seller-applications — "Sell with us". */
export function sellerApplicationRoutes(c: Container): Router {
  const r = Router();
  r.post('/', async (req, res) => {
    const data = await c.support.createSellerApplication(parseBody(SellerApplicationSchema, req.body));
    res.status(201).json(created(data, 'Application received'));
  });
  return r;
}

/** POST /api/analytics/events — storefront funnel events (FR-IN-05); the user is attached when signed in. */
export function analyticsRoutes(c: Container): Router {
  const r = Router();
  r.post('/events', async (req, res) => {
    const data = await c.analytics.record(parseBody(AnalyticsBatchSchema, req.body), req.user?.id ?? null);
    res.status(202).json(ok(data, 'Events recorded'));
  });
  return r;
}
