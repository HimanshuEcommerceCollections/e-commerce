import { randomInt } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { withUniqueReference } from '../common/reference';
import { optionalString, requiredString } from '../common/validation';
import type { Config } from '../config';
import type { Mailer } from '../notify/mailer';
import { normalizeOrderNumber } from '../order/order-number';
import { usStateCode } from './us-states';

const email = () =>
  requiredString({
    blankMessage: 'Email is required',
    email: true,
    emailMessage: 'Must be a valid email address',
    max: 255,
    sizeMessage: 'Email must not exceed 255 characters',
  });

/** The help center's topic menu, verbatim (frontend HelpCenter CONTACT_TOPICS). */
export const SUPPORT_TOPICS = [
  'Where is my order?',
  'Returns and refunds',
  'Damaged or wrong item',
  'Payment or billing',
  'Product question',
  'Account',
  'Something else',
] as const;

/**
 * A required string that is then checked and normalised. `requiredString`
 * reports blank / too long first; the check runs only when that passed.
 */
const normalised = (
  rules: Parameters<typeof requiredString>[0],
  check: (value: string) => string | null,
  message: string,
) =>
  requiredString(rules).pipe(
    z.string().transform((value, ctx) => {
      const out = check(value);
      if (out === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        return z.NEVER;
      }
      return out;
    }),
  );

/** "(503) 555-0199", "503.555.0199" or "+1 503 555 0199" → "(503) 555-0199". */
function usPhone(value: string): string | null {
  if (!/^[+]?[0-9 ().-]{7,30}$/.test(value.trim())) return null;
  let d = value.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}

/**
 * Category list. A bad entry is reported both at `categories[i]` and at
 * `categories`, so a form that only knows the list field still shows it.
 */
const categoryList = () =>
  z.unknown().transform((value, ctx): string[] => {
    const fail = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
      fail('Choose at least one category');
      return z.NEVER;
    }
    if (!Array.isArray(value)) {
      fail('must be a list of categories');
      return z.NEVER;
    }
    if (value.length > 20) {
      fail('Choose at most 20 categories');
      return z.NEVER;
    }
    let bad: string | null = null;
    value.forEach((c, i) => {
      const message =
        typeof c !== 'string' || c.trim() === ''
          ? 'Category must not be blank'
          : c.length > 100
            ? 'Category must not exceed 100 characters'
            : null;
      if (message) {
        fail(message, [i]);
        bad ??= message;
      }
    });
    if (bad) {
      fail(bad);
      return z.NEVER;
    }
    return value as string[];
  });

/** Help center contact form (design 10). */
export const SupportMessageSchema = z.object({
  name: requiredString({ blankMessage: 'Name is required', max: 200, sizeMessage: 'Name must not exceed 200 characters' }),
  email: email(),
  topic: normalised(
    { blankMessage: 'Topic is required' },
    (v) => SUPPORT_TOPICS.find((t) => t.toLowerCase() === v.trim().toLowerCase()) ?? null,
    'Choose a topic.',
  ),
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
  // Messages for the checks tightened in D1 are the form's own (SellWithUs MESSAGES).
  phone: normalised(
    { blankMessage: 'Phone is required', max: 30, sizeMessage: 'Phone must not exceed 30 characters' },
    usPhone,
    'Enter a 10-digit US phone number',
  ),
  categories: categoryList(),
  products: normalised(
    { blankMessage: 'Tell us which products you want to sell', max: 2000, sizeMessage: 'Products must not exceed 2000 characters' },
    (v) => (v.trim().length >= 3 ? v : null),
    'Tell us which products you want to sell',
  ),
  street: requiredString({ blankMessage: 'Street is required', max: 255, sizeMessage: 'Street must not exceed 255 characters' }),
  city: requiredString({ blankMessage: 'City is required', max: 100, sizeMessage: 'City must not exceed 100 characters' }),
  state: normalised({ blankMessage: 'Select a state', max: 100, sizeMessage: 'Select a state' }, usStateCode, 'Select a state'),
  postalCode: normalised(
    { blankMessage: 'Enter a 5-digit ZIP', max: 20, sizeMessage: 'Enter a 5-digit ZIP' },
    (v) => (/^\d{5}$/.test(v.trim()) ? v.trim() : null),
    'Enter a 5-digit ZIP',
  ),
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
            topic: input.topic,
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
            phone: input.phone,
            categories: [...new Set(input.categories.map((c) => c.trim()))],
            products: input.products.trim(),
            street: input.street.trim(),
            city: input.city.trim(),
            state: input.state,
            postalCode: input.postalCode,
            // The schema accepts only consent === true, so this is the moment it was given.
            consentAt: new Date(),
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
