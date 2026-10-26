import type { PrismaClient, User } from '@prisma/client';
import { z } from 'zod';
import type { ClientInfo, SessionService } from '../account/sessions.service';
import { maskPhone } from '../account/two-factor.service';
import { checkPassword, emailField, hashPassword, newPassword, phoneField, type AuthService } from '../auth/auth.service';
import { money } from '../common/api-response';
import { DomainError, EmailAlreadyRegisteredError, PhoneAlreadyRegisteredError } from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { requiredString } from '../common/validation';
import { TX } from '../db';

const BIRTHDAY_MESSAGE = 'Enter a valid date as MM/DD.';
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** "MM/DD" or "MM-DD" (also "3/7") → "03-07"; null or "" clears it. */
const birthdayField = () =>
  z.unknown().transform((v, ctx): string | null => {
    if (v === null || (typeof v === 'string' && v.trim() === '')) return null;
    const m = typeof v === 'string' ? /^\s*(\d{1,2})\s*[/-]\s*(\d{1,2})\s*$/.exec(v) : null;
    const month = m ? Number(m[1]) : 0;
    const day = m ? Number(m[2]) : 0;
    if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]!) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: BIRTHDAY_MESSAGE });
      return z.NEVER;
    }
    return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  });

/** PATCH /api/users/me: only the fields sent change. */
export const ProfileUpdateSchema = z.object({
  fullName: requiredString({
    blankMessage: 'Full name must not be blank',
    max: 200,
    sizeMessage: 'Full name must not exceed 200 characters',
  }).optional(),
  email: emailField().optional(),
  // null or "" clears the phone number.
  phoneNumber: z.union([z.null(), phoneField()]).optional(),
  marketingOptIn: z.boolean({ invalid_type_error: 'must be a boolean' }).optional(),
  birthday: birthdayField().optional(),
  currentPassword: z.string({ invalid_type_error: 'must be a string' }).optional(),
});

export const PasswordChangeSchema = z.object({
  currentPassword: requiredString({ blankMessage: 'Current password is required' }),
  newPassword: newPassword('New password is required'),
  /** Default true: every other device is signed out. */
  signOutOtherDevices: z
    .boolean({ invalid_type_error: 'must be a boolean' })
    .nullish()
    .transform((v) => v ?? true),
});

export class IncorrectPasswordError extends DomainError {
  constructor() {
    super(400, 'Your current password is incorrect');
  }
}

export function toUserProfile(u: User) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    phoneNumber: u.phoneNumber,
    marketingOptIn: u.marketingOptIn,
    role: u.role,
    createdAt: u.createdAt,
    birthday: u.birthday,
    passwordChangedAt: u.passwordChangedAt,
    twoFactorEnabled: u.twoFactorEnabled,
    twoFactorPhone: u.twoFactorEnabled ? maskPhone(u.twoFactorPhone) : null,
    storeCreditBalance: money(u.storeCreditBalance),
  };
}

/** The signed-in customer's own details (design 08, "Details" and "Sign-in & security"). */
export class AccountService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  async getProfile(user: User) {
    return toUserProfile(user);
  }

  /**
   * Changing the email needs the current password, and returns a fresh token
   * for the same session: tokens are keyed by email, so the old ones stop working.
   */
  async updateProfile(user: User, input: z.output<typeof ProfileUpdateSchema>, sessionId?: string) {
    const emailChanged = input.email !== undefined && input.email !== user.email;
    if (emailChanged) {
      if (!input.currentPassword || !(await checkPassword(input.currentPassword, user.password))) {
        throw new IncorrectPasswordError();
      }
      const taken = await this.prisma.user.findFirst({
        where: { email: { equals: input.email!, mode: 'insensitive' }, id: { not: user.id } },
      });
      if (taken) throw new EmailAlreadyRegisteredError(input.email!);
    }
    const phone = input.phoneNumber === undefined ? undefined : (input.phoneNumber ?? null);
    if (phone && phone !== user.phoneNumber) {
      const taken = await this.prisma.user.findFirst({ where: { phoneNumber: phone, id: { not: user.id } } });
      if (taken) throw new PhoneAlreadyRegisteredError(phone);
    }

    let updated: User;
    try {
      updated = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
          ...(emailChanged ? { email: input.email } : {}),
          ...(phone !== undefined ? { phoneNumber: phone } : {}),
          ...(input.marketingOptIn !== undefined ? { marketingOptIn: input.marketingOptIn } : {}),
          ...(input.birthday !== undefined ? { birthday: input.birthday } : {}),
        },
      });
    } catch (e) {
      // Lost a race for the same email or phone.
      if (isIntegrityViolation(e)) {
        throw emailChanged ? new EmailAlreadyRegisteredError(input.email!) : new PhoneAlreadyRegisteredError(phone ?? '');
      }
      throw e;
    }
    return {
      profile: toUserProfile(updated),
      auth: emailChanged ? this.auth.issue(updated, { sessionId, rememberMe: true }) : null,
    };
  }

  /**
   * New password. By default every other device is signed out (their
   * sessions revoked, and tokens issued before now refused) and a fresh token
   * for this session comes back. With signOutOtherDevices=false nothing else
   * changes: other sessions keep working.
   */
  async changePassword(
    user: User,
    input: z.output<typeof PasswordChangeSchema>,
    sessionId?: string,
    client: ClientInfo = {},
  ) {
    if (!(await checkPassword(input.currentPassword, user.password))) throw new IncorrectPasswordError();
    const password = await hashPassword(input.newPassword);
    if (!input.signOutOtherDevices) {
      const updated = await this.prisma.user.update({ where: { id: user.id }, data: { password } });
      return sessionId ? this.auth.issue(updated, { sessionId, rememberMe: true }) : this.auth.startSession(updated, client);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.sessions.revokeOthers(user.id, sessionId ?? null, tx);
      return tx.user.update({ where: { id: user.id }, data: { password, passwordChangedAt: new Date() } });
    }, TX.default);
    // A legacy token has no session to keep: this device gets a new one.
    return sessionId ? this.auth.issue(updated, { sessionId, rememberMe: true }) : this.auth.startSession(updated, client);
  }
}
