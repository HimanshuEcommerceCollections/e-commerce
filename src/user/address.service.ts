import type { PrismaClient, UserAddress } from '@prisma/client';
import { z } from 'zod';
import { AddressLimitExceededError, AddressNotFoundError } from '../common/errors';
import { flag, optionalString, requiredString } from '../common/validation';
import { TX, type Db } from '../db';
import { isUsState, stateCode } from '../order/state-tax';

/** US ZIP or ZIP+4. */
export const US_ZIP = /^\d{5}(-\d{4})?$/;

const isUs = (country: string | null | undefined) => !country?.trim() || /^(us|usa|united states( of america)?)$/i.test(country.trim());

/** "P.O. Box 12", "PO Box", "Post Office Box", "POB 4": Express carriers can't deliver there. */
export function isPoBox(line: string | null | undefined): boolean {
  return !!line && /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box|pob)\b/i.test(line);
}

/**
 * US address rules (contract B4): the state is one of the 50 states or DC
 * (code or full name), the ZIP is 5 digits or ZIP+4. Other countries pass
 * through. `prefix` names the fields in the 400 ("shippingAddress.state").
 */
export function checkUsAddress(
  a: { state?: string | null; postalCode?: string | null; country?: string | null },
  ctx: z.RefinementCtx,
  prefix: (string | number)[] = [],
) {
  if (!isUs(a.country)) return;
  if (a.state?.trim() && !isUsState(a.state)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...prefix, 'state'], message: 'Choose a state.' });
  }
  if (a.postalCode?.trim() && !US_ZIP.test(a.postalCode.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...prefix, 'postalCode'], message: 'Enter a 5-digit ZIP code.' });
  }
}

/** A US state stored as its 2-letter code ("oregon" → "OR"); anything else as typed. */
export const normalizeState = (state: string, country?: string | null) =>
  isUs(country) ? stateCode(state) ?? state.trim() : state.trim();

const AddressFields = z.object({
  /** Optional: "Home" for a first address, else "Other". */
  label: optionalString({ max: 50, sizeMessage: 'Label must not exceed 50 characters' }),
  recipientName: requiredString({
    blankMessage: 'Recipient name is required',
    max: 200,
    sizeMessage: 'Recipient name must not exceed 200 characters',
  }),
  phone: optionalString({
    max: 20,
    sizeMessage: 'Phone must not exceed 20 characters',
    pattern: /^$|^\+?[0-9 ()\-]{6,20}$/,
    patternMessage: "Phone must contain only digits, spaces, parentheses, hyphens, and an optional leading '+'",
  }),
  addressLine1: requiredString({
    blankMessage: 'Address line 1 is required',
    max: 255,
    sizeMessage: 'Address line 1 must not exceed 255 characters',
  }),
  addressLine2: optionalString({ max: 255, sizeMessage: 'Address line 2 must not exceed 255 characters' }),
  city: requiredString({ blankMessage: 'City is required', max: 100, sizeMessage: 'City must not exceed 100 characters' }),
  state: requiredString({ blankMessage: 'State is required', max: 100, sizeMessage: 'State must not exceed 100 characters' }),
  postalCode: requiredString({
    blankMessage: 'Postal code is required',
    max: 20,
    sizeMessage: 'Postal code must not exceed 20 characters',
  }),
  country: requiredString({ blankMessage: 'Country is required', max: 100, sizeMessage: 'Country must not exceed 100 characters' }),
  isDefault: flag(),
});

export const AddressSchema = AddressFields.superRefine((a, ctx) => checkUsAddress(a, ctx));

export type AddressInput = z.output<typeof AddressSchema>;

export function toAddressResponse(a: UserAddress) {
  return {
    id: a.id,
    label: a.label,
    recipientName: a.recipientName,
    phone: a.phone,
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2,
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    country: a.country,
    isDefault: a.isDefault,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function fields(input: AddressInput, defaultLabel: string) {
  return {
    label: input.label?.trim() || defaultLabel,
    recipientName: input.recipientName,
    phone: input.phone ?? null,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2 ?? null,
    city: input.city,
    state: normalizeState(input.state, input.country),
    postalCode: input.postalCode,
    country: input.country,
  };
}

/**
 * A user's saved shipping addresses. Every mutation takes a per-user
 * transaction-scoped advisory lock, so the max-per-user count and the
 * single-default rule (also backed by uniq_user_addresses_default) hold under
 * concurrent requests.
 */
export class AddressService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly maxPerUser: number,
  ) {}

  create(userId: string, input: AddressInput) {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const count = await tx.userAddress.count({ where: { userId, deleted: false } });
      if (count >= this.maxPerUser) throw new AddressLimitExceededError(this.maxPerUser);

      const makeDefault = input.isDefault || count === 0;
      if (makeDefault) {
        await tx.userAddress.updateMany({ where: { userId, deleted: false }, data: { isDefault: false } });
      }
      const address = await tx.userAddress.create({
        data: { userId, ...fields(input, count === 0 ? 'Home' : 'Other'), isDefault: makeDefault },
      });
      return toAddressResponse(address);
    }, TX.default);
  }

  async findAll(userId: string) {
    const rows = await this.prisma.userAddress.findMany({
      where: { userId, deleted: false },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toAddressResponse);
  }

  async findById(userId: string, id: string) {
    return toAddressResponse(await resolveOwned(this.prisma, userId, id));
  }

  update(userId: string, id: string, input: AddressInput) {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const address = await resolveOwned(tx, userId, id);
      // Unsetting isDefault is ignored: a user always keeps one default.
      const becomeDefault = input.isDefault && !address.isDefault;
      if (becomeDefault) {
        await tx.userAddress.updateMany({
          where: { userId, deleted: false, id: { not: id } },
          data: { isDefault: false },
        });
      }
      const updated = await tx.userAddress.update({
        where: { id },
        // A blank label keeps the one it had.
        data: { ...fields(input, address.label), ...(becomeDefault ? { isDefault: true } : {}) },
      });
      return toAddressResponse(updated);
    }, TX.default);
  }

  delete(userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const address = await resolveOwned(tx, userId, id);
      await tx.userAddress.update({ where: { id }, data: { deleted: true } });

      // Deleting the default promotes the newest remaining address.
      if (address.isDefault) {
        const next = await tx.userAddress.findFirst({
          where: { userId, deleted: false, id: { not: id } },
          orderBy: { createdAt: 'desc' },
        });
        if (next) await tx.userAddress.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }, TX.default);
  }

  setDefault(userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const address = await resolveOwned(tx, userId, id);
      if (address.isDefault) return toAddressResponse(address);

      await tx.userAddress.updateMany({
        where: { userId, deleted: false, id: { not: id } },
        data: { isDefault: false },
      });
      return toAddressResponse(await tx.userAddress.update({ where: { id }, data: { isDefault: true } }));
    }, TX.default);
  }
}

async function resolveOwned(db: Db, userId: string, id: string) {
  const address = await db.userAddress.findFirst({ where: { id, userId, deleted: false } });
  if (!address) throw new AddressNotFoundError(id);
  return address;
}

/**
 * Keeps an address typed at checkout ("save for next time"). Best effort, in
 * the checkout transaction: skipped when the same address is already saved or
 * the account is at its limit — checkout never fails over it.
 */
export async function saveCheckoutAddress(
  db: Db,
  userId: string,
  a: {
    recipientName: string;
    phone: string | null;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  },
  maxPerUser: number,
) {
  await lockUser(db, userId);
  const existing = await db.userAddress.findMany({ where: { userId, deleted: false } });
  const same = (x: string | null, y: string | null) => (x ?? '').trim().toLowerCase() === (y ?? '').trim().toLowerCase();
  if (
    existing.some(
      (e) =>
        same(e.recipientName, a.recipientName) &&
        same(e.addressLine1, a.addressLine1) &&
        same(e.addressLine2, a.addressLine2) &&
        same(e.postalCode, a.postalCode),
    ) ||
    existing.length >= maxPerUser
  ) {
    return null;
  }
  return db.userAddress.create({
    data: { userId, label: existing.length === 0 ? 'Home' : 'Other', ...a, isDefault: existing.length === 0 },
  });
}

async function lockUser(db: Db, userId: string) {
  // ::text — pg_advisory_xact_lock returns void, which Prisma can't deserialize.
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'user_address:' + userId}))::text`;
}
