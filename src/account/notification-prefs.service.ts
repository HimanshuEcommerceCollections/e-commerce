import type { NotificationPreference, PrismaClient, User } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../common/validation';
import { TX } from '../db';
import { NO_PHONE_MESSAGE } from './two-factor.service';

const toggle = () => z.boolean({ invalid_type_error: 'must be a boolean' }).optional();

/** PATCH: only the keys sent change. Order updates can't be turned off, so `orderUpdates` is accepted and ignored. */
export const NotificationPrefsUpdateSchema = z.object({
  orderUpdates: toggle(),
  deals: toggle(),
  newArrivals: toggle(),
  priceDrops: toggle(),
  backInStock: toggle(),
  reviewReminders: toggle(),
  smsDelivery: toggle(),
});

/** Column defaults, for a customer who never saved preferences. */
const DEFAULTS = { newArrivals: false, priceDrops: true, backInStock: true, reviewReminders: true, smsDelivery: false };

function toPrefsResponse(user: User, row: NotificationPreference | null) {
  const p = row ?? DEFAULTS;
  return {
    orderUpdates: true,
    deals: user.marketingOptIn,
    newArrivals: p.newArrivals,
    priceDrops: p.priceDrops,
    backInStock: p.backInStock,
    reviewReminders: p.reviewReminders,
    smsDelivery: p.smsDelivery,
    phone: user.phoneNumber,
  };
}

/**
 * Email and text preferences (design 08, "Notifications"). "Deals & offers"
 * is users.marketing_opt_in, the same flag sign-up and checkout set; the rest
 * live in notification_preferences, created on first save.
 */
export class NotificationPrefsService {
  constructor(private readonly prisma: PrismaClient) {}

  async get(user: User) {
    return toPrefsResponse(user, await this.prisma.notificationPreference.findUnique({ where: { userId: user.id } }));
  }

  async update(user: User, input: z.output<typeof NotificationPrefsUpdateSchema>) {
    if (input.smsDelivery && !user.phoneNumber) throw new ValidationError({ smsDelivery: NO_PHONE_MESSAGE });
    const prefs = {
      ...(input.newArrivals !== undefined ? { newArrivals: input.newArrivals } : {}),
      ...(input.priceDrops !== undefined ? { priceDrops: input.priceDrops } : {}),
      ...(input.backInStock !== undefined ? { backInStock: input.backInStock } : {}),
      ...(input.reviewReminders !== undefined ? { reviewReminders: input.reviewReminders } : {}),
      ...(input.smsDelivery !== undefined ? { smsDelivery: input.smsDelivery } : {}),
    };
    return this.save(user, prefs, input.deals);
  }

  /** "Unsubscribe from all marketing": every promotional email off; order updates and texts stay. */
  async unsubscribeAll(user: User) {
    return this.save(user, { newArrivals: false, priceDrops: false, backInStock: false, reviewReminders: false }, false);
  }

  private async save(user: User, prefs: Partial<typeof DEFAULTS>, deals: boolean | undefined) {
    const [updatedUser, row] = await this.prisma.$transaction(async (tx) => {
      const u =
        deals !== undefined && deals !== user.marketingOptIn
          ? await tx.user.update({ where: { id: user.id }, data: { marketingOptIn: deals } })
          : user;
      const r = await tx.notificationPreference.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...DEFAULTS, ...prefs },
        update: prefs,
      });
      return [u, r] as const;
    }, TX.default);
    return toPrefsResponse(updatedUser, row);
  }
}
