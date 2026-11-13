import type { PrismaClient } from '@prisma/client';
import nodemailer, { type Transporter } from 'nodemailer';
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

export interface MailConfig {
  provider: 'log' | 'smtp';
  /** From header used for SMTP delivery. */
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
}

/**
 * Customer messages (order confirmation, shipping, refunds, password reset…).
 * Every message is stored in `notifications` so ops and QA can see what a
 * customer received.
 *  - MAIL_PROVIDER=log: stored and logged only (status LOGGED).
 *  - MAIL_PROVIDER=smtp: also delivered over SMTP (status SENT, or FAILED).
 *
 * Never throws: a message is a side effect of a request that has already
 * succeeded (an order placed, a refund issued), and failing that request
 * because the message couldn't be sent would be worse than a missing
 * email. Call it after the business transaction commits.
 */
export class Mailer {
  private readonly transport: Transporter | null;
  private readonly from: string;

  constructor(
    private readonly prisma: PrismaClient,
    config: MailConfig | 'log' = 'log',
  ) {
    if (typeof config === 'object' && config.provider === 'smtp') {
      const { host, port, secure, user, pass } = config.smtp;
      this.transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
      this.from = config.from || user;
    } else {
      this.transport = null;
      this.from = '';
    }
  }

  /** Resolves to the notification id, or null when it could not be recorded. */
  async send(message: MailMessage): Promise<string | null> {
    let status: NotificationStatus = 'LOGGED';
    if (this.transport) {
      try {
        await this.transport.sendMail({
          from: this.from,
          to: message.to,
          subject: message.subject,
          text: message.body,
        });
        status = 'SENT';
      } catch (e) {
        status = 'FAILED';
        log.warn(`SMTP delivery of ${message.template} to ${message.to} failed`, e);
      }
    }
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
      log.info(`${message.template} → ${message.to} [${status}]: ${message.subject}`);
      return row.id;
    } catch (e) {
      log.warn(`Could not record ${message.template} message to ${message.to}`, e);
      return null;
    }
  }
}
