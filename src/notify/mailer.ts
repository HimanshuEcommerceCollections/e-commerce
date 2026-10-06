import type { PrismaClient } from '@prisma/client';
import type { NotificationStatus, NotificationTemplate } from '../common/enums';
import { logger } from '../common/logger';

const log = logger('mailer');

export interface MailMessage {
  template: NotificationTemplate;
  to: string;
  subject: string;
  /** Plain text. */
  body: string;
  orderId?: string | null;
  userId?: string | null;
}

/**
 * Customer messages (order confirmation, shipping, refunds, password reset…).
 * MAIL_PROVIDER=log is the only provider: each message is stored in
 * `notifications` and logged, so ops and QA can see what a customer would
 * have received. A real SMTP/API provider slots in behind `send` later.
 *
 * Never throws: a message is a side effect of a request that has already
 * succeeded (an order placed, a refund issued), and failing that request
 * because the message couldn't be recorded would be worse than a missing
 * email. Call it after the business transaction commits.
 */
export class Mailer {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: 'log' = 'log',
  ) {}

  /** Resolves to the notification id, or null when it could not be recorded. */
  async send(message: MailMessage): Promise<string | null> {
    const status: NotificationStatus = this.provider === 'log' ? 'LOGGED' : 'SENT';
    try {
      const row = await this.prisma.notification.create({
        data: {
          template: message.template,
          toAddress: message.to.slice(0, 255),
          subject: message.subject.slice(0, 255),
          body: message.body,
          orderId: message.orderId ?? null,
          userId: message.userId ?? null,
          status,
        },
        select: { id: true },
      });
      log.info(`${message.template} → ${message.to}: ${message.subject}`);
      return row.id;
    } catch (e) {
      log.warn(`Could not record ${message.template} message to ${message.to}`, e);
      return null;
    }
  }
}
