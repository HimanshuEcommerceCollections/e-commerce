import type { PrismaClient, WebhookEvent } from '@prisma/client';
import type { WebhookEventStatus } from '../../common/enums';
import { isIntegrityViolation } from '../../common/error-handler';
import { logger } from '../../common/logger';

const log = logger('webhook-store');

/**
 * Durable store of provider webhook events. Every operation is its own
 * statement/transaction, independent of dispatch, so an event row survives
 * (FAILED, replayable) even when processing fails.
 */
export class WebhookEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Persist the event as RECEIVED before any processing.
   * @returns the existing status if the event id was already recorded
   *          (at-least-once delivery), or null if this call inserted it and
   *          the caller should dispatch
   */
  async recordReceived(eventId: string, eventType: string, payload: string | null): Promise<WebhookEventStatus | null> {
    const existing = await this.prisma.webhookEvent.findUnique({ where: { eventId } });
    if (existing) return existing.status as WebhookEventStatus;
    try {
      await this.prisma.webhookEvent.create({
        data: { eventId, eventType, payload, status: 'RECEIVED', receivedAt: new Date() },
      });
      return null;
    } catch (e) {
      if (!isIntegrityViolation(e)) throw e;
      // Lost the insert race to a concurrent delivery, which owns processing.
      log.info(`Concurrent duplicate delivery of webhook event ${eventId}`);
      return 'RECEIVED';
    }
  }

  /**
   * Take ownership of a stored event before re-dispatching it: FAILED events
   * always; RECEIVED ones only once their lease has run out (the processor
   * crashed). Resetting received_at restarts the lease. Exactly one of any set
   * of concurrent redeliveries or replays wins.
   * @param staleBefore RECEIVED events received before this are reclaimable
   */
  async claimForRedispatch(eventId: string, staleBefore: Date): Promise<boolean> {
    const claimed = await this.prisma.$executeRaw`
      UPDATE webhook_events SET status = 'RECEIVED', received_at = now()
       WHERE event_id = ${eventId}
         AND (status = 'FAILED' OR (status = 'RECEIVED' AND received_at < ${staleBefore}))`;
    return claimed === 1;
  }

  async markProcessed(eventId: string) {
    await this.prisma.webhookEvent.updateMany({
      where: { eventId },
      data: { status: 'PROCESSED', errorMessage: null, processedAt: new Date() },
    });
  }

  async markFailed(eventId: string, error: string | null) {
    await this.prisma.webhookEvent.updateMany({
      where: { eventId },
      data: { status: 'FAILED', errorMessage: error ? error.slice(0, 1000) : null, processedAt: new Date() },
    });
  }

  find(eventId: string): Promise<WebhookEvent | null> {
    return this.prisma.webhookEvent.findUnique({ where: { eventId } });
  }
}
