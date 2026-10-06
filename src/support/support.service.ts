import { randomInt } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { isIntegrityViolation } from '../common/error-handler';
import { optionalString, requiredString } from '../common/validation';
import type { Config } from '../config';
import type { Mailer } from '../notify/mailer';
import { normalizeOrderNumber } from '../order/order-number';

const email = () =>
  requiredString({
    blankMessage: 'Email is required',
    email: true,
    emailMessage: 'Must be a valid email address',
    max: 255,
    sizeMessage: 'Email must not exceed 255 characters',
  });

/** Help center contact form (design 10). */
export const SupportMessageSchema = z.object({
  name: requiredString({ blankMessage: 'Name is required', max: 200, sizeMessage: 'Name must not exceed 200 characters' }),
  email: email(),
  topic: requiredString({ blankMessage: 'Topic is required', max: 50, sizeMessage: 'Topic must not exceed 50 characters' }),
  orderNumber: optionalString({ max: 40, sizeMessage: 'Order number must not exceed 40 characters' }),
  message: requiredString({
    blankMessage: 'Message is required',
    min: 10,
    max: 1500,
    sizeMessage: 'Message must be between 10 and 1500 characters',
  }),
});

/** "Sell with us" application (design 11). */
export const SellerApplicationSchema = z.object({
  fullName: requiredString({ blankMessage: 'Full name is required', max: 200, sizeMessage: 'Full name must not exceed 200 characters' }),
  email: email(),
  phone: requiredString({
    blankMessage: 'Phone is required',
    pattern: /^[+]?[0-9 ()-]{7,30}$/,
    patternMessage: 'Must be a valid phone number',
    max: 30,
    sizeMessage: 'Phone must not exceed 30 characters',
  }),
  categories: z
    .array(
      requiredString({ blankMessage: 'Category must not be blank', max: 100, sizeMessage: 'Category must not exceed 100 characters' }),
      { required_error: 'Choose at least one category', invalid_type_error: 'must be a list of categories' },
    )
    .min(1, 'Choose at least one category')
    .max(20, 'Choose at most 20 categories'),
  products: requiredString({
    blankMessage: 'Tell us what you sell',
    max: 2000,
    sizeMessage: 'Products must not exceed 2000 characters',
  }),
  street: requiredString({ blankMessage: 'Street is required', max: 255, sizeMessage: 'Street must not exceed 255 characters' }),
  city: requiredString({ blankMessage: 'City is required', max: 100, sizeMessage: 'City must not exceed 100 characters' }),
  state: requiredString({ blankMessage: 'State is required', max: 100, sizeMessage: 'State must not exceed 100 characters' }),
  postalCode: requiredString({ blankMessage: 'Postal code is required', max: 20, sizeMessage: 'Postal code must not exceed 20 characters' }),
  consent: z.literal(true, { errorMap: () => ({ message: 'You must agree to be contacted about your application' }) }),
});

/**
 * Help-center messages and seller applications: stored for the team to work
 * through, with an acknowledgement emailed to the sender.
 */
export class SupportService {
  private readonly storeName: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mailer: Mailer,
    config: Config,
  ) {
    this.storeName = config.store.name;
  }

  async createMessage(input: z.output<typeof SupportMessageSchema>) {
    const row = await withUniqueReference(
      () => `T-${randomInt(100_000, 1_000_000)}`,
      (ticketNumber) =>
        this.prisma.supportMessage.create({
          data: {
            ticketNumber,
            name: input.name.trim(),
            email: input.email.trim(),
            topic: input.topic.trim(),
            orderNumber: input.orderNumber?.trim() ? normalizeOrderNumber(input.orderNumber) : null,
            message: input.message.trim(),
          },
        }),
    );
    await this.mailer.send({
      template: 'SUPPORT_TICKET',
      to: row.email,
      subject: `${this.storeName}: we received your message (${row.ticketNumber})`,
      body:
        `Hi ${row.name}, thanks for getting in touch. Your ticket number is ${row.ticketNumber}; ` +
        `we usually reply within one business day.\n\nYour message:\n${row.message}`,
    });
    return { ticketNumber: row.ticketNumber };
  }

  async createSellerApplication(input: z.output<typeof SellerApplicationSchema>) {
    const row = await withUniqueReference(
      () => `SA-${randomInt(10_000, 100_000)}`,
      (reference) =>
        this.prisma.sellerApplication.create({
          data: {
            reference,
            fullName: input.fullName.trim(),
            email: input.email.trim(),
            phone: input.phone.trim(),
            categories: [...new Set(input.categories.map((c) => c.trim()))],
            products: input.products.trim(),
            street: input.street.trim(),
            city: input.city.trim(),
            state: input.state.trim(),
            postalCode: input.postalCode.trim(),
          },
        }),
    );
    await this.mailer.send({
      template: 'SELLER_APPLICATION',
      to: row.email,
      subject: `${this.storeName}: application ${row.reference} received`,
      body:
        `Hi ${row.fullName}, thanks for applying to sell with ${this.storeName}. ` +
        `Your reference is ${row.reference}. Our team will review your application and get back to you.`,
    });
    return { reference: row.reference };
  }
}

/** Short random references; the unique index decides, and a clash just draws again. */
async function withUniqueReference<T>(next: () => string, insert: (ref: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await insert(next());
    } catch (e) {
      if (!isIntegrityViolation(e) || attempt >= 9) throw e;
    }
  }
}
