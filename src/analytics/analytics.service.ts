import { Prisma, type Order, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { CLIENT_ANALYTICS_EVENT_TYPES } from '../common/enums';
import { logger } from '../common/logger';
import { decimal, optionalString, optionalUuid, requiredString } from '../common/validation';
import type { Db } from '../db';

const log = logger('analytics');

const MAX_PROPERTIES_BYTES = 2048;

const EventSchema = z.object({
  eventType: z.enum(CLIENT_ANALYTICS_EVENT_TYPES, {
    errorMap: () => ({ message: `must be one of ${CLIENT_ANALYTICS_EVENT_TYPES.join(', ')}` }),
  }),
  sessionId: requiredString({ blankMessage: 'Session id is required', max: 100, sizeMessage: 'size must be between 0 and 100' }),
  productId: optionalUuid(),
  value: decimal({ positiveOrZero: true, max: 9_999_999_999 }),
  currency: optionalString({ pattern: /^[A-Za-z]{3}$/, patternMessage: 'must be a 3-letter currency code' }),
  path: optionalString({ max: 2048 }),
  properties: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]), {
      invalid_type_error: 'must be an object of strings, numbers or booleans',
    })
    .optional()
    .nullable()
    .refine((p) => !p || JSON.stringify(p).length <= MAX_PROPERTIES_BYTES, `must not exceed ${MAX_PROPERTIES_BYTES} bytes`),
});

/** POST /api/analytics/events: a batch of up to 25 storefront events. */
export const AnalyticsBatchSchema = z.object({
  events: z
    .array(EventSchema, { required_error: 'must not be null', invalid_type_error: 'must be a list of events' })
    .min(1, 'must contain at least one event')
    .max(25, 'at most 25 events per call'),
});

/**
 * Funnel events (FR-IN-05): product view, add to cart and checkout start from
 * the browser; PURCHASE written here when an order is paid, so it can't be
 * faked or blocked by the client.
 */
export class AnalyticsService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Stores a browser batch; the signed-in user (if any) is attached server-side. */
  async record(input: z.output<typeof AnalyticsBatchSchema>, userId: string | null) {
    const { count } = await this.prisma.analyticsEvent.createMany({
      data: input.events.map((e) => ({
        eventType: e.eventType,
        sessionId: e.sessionId,
        userId,
        productId: e.productId ?? null,
        value: e.value ?? null,
        currency: e.currency?.toUpperCase() ?? null,
        path: e.path ?? null,
        properties: e.properties ?? Prisma.DbNull,
      })),
    });
    return { accepted: count };
  }

  /** One PURCHASE per paid order. Never throws: the payment has already been recorded. */
  async recordPurchase(order: Pick<Order, 'id' | 'orderNumber' | 'userId' | 'grandTotal' | 'currency'>, itemCount: number, db: Db = this.prisma) {
    try {
      await db.analyticsEvent.create({
        data: {
          eventType: 'PURCHASE',
          userId: order.userId,
          orderId: order.id,
          value: order.grandTotal,
          currency: order.currency,
          properties: { orderNumber: order.orderNumber, itemCount },
        },
      });
    } catch (e) {
      log.warn(`Could not record PURCHASE for order ${order.orderNumber}`, e);
    }
  }
}
