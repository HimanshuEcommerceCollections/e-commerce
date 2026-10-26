import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { userRateLimit } from '../auth/rate-limit';
import { created, noContent, ok } from '../common/api-response';
import { parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';
import { toUserProfile } from '../user/account.service';
import { GiftCardRedeemSchema } from './gift-cards.service';
import { NotificationPrefsUpdateSchema } from './notification-prefs.service';
import { PaymentMethodAddSchema } from './payment-methods.service';
import { AccountDeleteSchema } from './privacy.service';
import type { ClientInfo } from './sessions.service';
import { OtpConfirmSchema, TwoFactorStartSchema } from './two-factor.service';

// Customer account settings (design 08): sessions, 2-step verification,
// notification preferences, store credit and gift cards, saved payment
// methods, data export and account deletion. Guards are per route: these
// routers share their mount points with others.

/** Where a request comes from, for the session it signs in. */
export const clientInfo = (req: express.Request): ClientInfo => ({
  userAgent: req.header('User-Agent') ?? null,
  ip: req.ip ?? null,
});

/** Mounted inside accountRoutes on /api/users/me (already behind requireAuth). */
export function accountSettingsRoutes(c: Container): Router {
  const r = Router();
  const signedIn = [requireAuth];
  const customer = [requireAuth, requireRole('ROLE_CUSTOMER')];
  const me = (req: express.Request) => currentUser(req);

  // ── Sessions ─────────────────────────────────────────────────────────────
  r.get('/sessions', ...signedIn, async (req, res) => {
    res.json(ok(await c.sessions.list(me(req).id, req.sessionId ?? null)));
  });
  // Before '/sessions/:id'.
  r.post('/sessions/revoke-others', ...signedIn, async (req, res) => {
    const revoked = await c.sessions.revokeOthers(me(req).id, req.sessionId ?? null);
    res.json(ok({ revoked }, 'Signed out of other devices'));
  });
  r.delete('/sessions/:id', ...signedIn, async (req, res) => {
    await c.sessions.revoke(me(req).id, pathUuid(req.params.id));
    res.json(noContent('Signed out of that device'));
  });

  // ── 2-step verification ──────────────────────────────────────────────────
  r.post('/2fa/start', ...signedIn, async (req, res) => {
    const data = await c.twoFactor.start(me(req), parseBody(TwoFactorStartSchema, req.body));
    res.json(ok(data, 'Code sent'));
  });
  r.post('/2fa/confirm', ...signedIn, async (req, res) => {
    const user = await c.twoFactor.confirm(me(req), parseBody(OtpConfirmSchema, req.body));
    res.json(ok(toUserProfile(user), '2-step verification is on'));
  });
  r.delete('/2fa', ...signedIn, async (req, res) => {
    const user = await c.twoFactor.disable(me(req));
    res.json(ok(toUserProfile(user), '2-step verification is off'));
  });

  // ── Notification preferences ─────────────────────────────────────────────
  r.get('/notification-preferences', ...signedIn, async (req, res) => {
    res.json(ok(await c.notificationPrefs.get(me(req))));
  });
  r.patch('/notification-preferences', ...signedIn, async (req, res) => {
    const input = parseBody(NotificationPrefsUpdateSchema, req.body);
    res.json(ok(await c.notificationPrefs.update(me(req), input), 'Preferences saved'));
  });
  r.post('/notification-preferences/unsubscribe-all', ...signedIn, async (req, res) => {
    res.json(ok(await c.notificationPrefs.unsubscribeAll(me(req)), 'Unsubscribed from marketing emails'));
  });

  // ── Store credit & gift cards ────────────────────────────────────────────
  r.get('/store-credit', ...customer, async (req, res) => {
    res.json(ok(await c.storeCredit.get(me(req))));
  });
  // 5 tries per 15 minutes per customer: the PIN is only 4 digits.
  r.post('/store-credit/redeem', ...customer, userRateLimit({ capacity: 5, windowMs: 15 * 60_000 }), async (req, res) => {
    const input = parseBody(GiftCardRedeemSchema, req.body);
    res.json(ok(await c.giftCards.redeem(me(req), input), 'Gift card added'));
  });

  // ── Saved payment methods (501 unless the gateway can vault cards) ──────
  r.get('/payment-methods', ...customer, async (req, res) => {
    res.json(ok(await c.paymentMethods.list(me(req))));
  });
  r.post('/payment-methods/setup-intent', ...customer, async (req, res) => {
    res.json(ok(await c.paymentMethods.createSetupIntent(me(req))));
  });
  r.post('/payment-methods', ...customer, async (req, res) => {
    const input = parseBody(PaymentMethodAddSchema, req.body);
    res.status(201).json(created(await c.paymentMethods.add(me(req), input), 'Payment method saved'));
  });
  r.patch('/payment-methods/:id/default', ...customer, async (req, res) => {
    res.json(ok(await c.paymentMethods.setDefault(me(req), pathUuid(req.params.id)), 'Default payment method updated'));
  });
  r.delete('/payment-methods/:id', ...customer, async (req, res) => {
    await c.paymentMethods.remove(me(req), pathUuid(req.params.id));
    res.json(noContent('Payment method removed'));
  });

  // ── Privacy ──────────────────────────────────────────────────────────────
  r.post('/data-export', ...customer, async (req, res) => {
    res.status(202).json(ok(await c.privacy.requestExport(me(req)), "We're preparing your data"));
  });
  r.get('/data-export', ...customer, async (req, res) => {
    res.json(ok(await c.privacy.latestExport(me(req))));
  });
  r.get('/data-export/:id/download', ...customer, async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    const file = await c.privacy.download(me(req), pathUuid(req.params.id), token);
    res.attachment(file.fileName).type('application/json').send(JSON.stringify(file.payload, null, 2));
  });
  r.post('/delete', ...customer, async (req, res) => {
    const input = parseBody(AccountDeleteSchema, req.body);
    res.json(ok(await c.privacy.deleteAccount(me(req), input), 'Your account has been deleted'));
  });
  return r;
}
