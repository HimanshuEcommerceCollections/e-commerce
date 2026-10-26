import { Router } from 'express';
import { GIFT_CARD_SORTS, GiftCardCreateSchema } from '../account/gift-cards.service';
import { StoreCreditAdjustSchema } from '../account/store-credit.service';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { created, ok } from '../common/api-response';
import { parsePageable } from '../common/pagination';
import { parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';

/**
 * Gift cards and manual store credit (contract C11). Mounted on /api/admin;
 * ROLE_ADMIN only, guarded per route so other admin paths fall through.
 */
export function adminGiftCardRoutes(c: Container): Router {
  const r = Router();
  const admin = [requireAuth, requireRole('ROLE_ADMIN')];
  r.post('/gift-cards', ...admin, async (req, res) => {
    const data = await c.giftCards.create(parseBody(GiftCardCreateSchema, req.body), currentUser(req).email);
    res.status(201).json(created(data, 'Gift card created. The code and PIN are shown only once.'));
  });
  r.get('/gift-cards', ...admin, async (req, res) => {
    res.json(ok(await c.giftCards.list(parsePageable(req, { sort: 'createdAt,desc', allowedSorts: GIFT_CARD_SORTS }))));
  });
  r.post('/customers/:id/store-credit', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(StoreCreditAdjustSchema, req.body);
    res.json(ok(await c.storeCredit.adjust(id, input, currentUser(req).email), 'Store credit updated'));
  });
  return r;
}
