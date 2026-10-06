import type { PrismaClient, User } from '@prisma/client';
import { z } from 'zod';
import { checkPassword, emailField, hashPassword, newPassword, phoneField, type AuthService } from '../auth/auth.service';
import { DomainError, EmailAlreadyRegisteredError, PhoneAlreadyRegisteredError } from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { requiredString } from '../common/validation';

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
  currentPassword: z.string({ invalid_type_error: 'must be a string' }).optional(),
});

export const PasswordChangeSchema = z.object({
  currentPassword: requiredString({ blankMessage: 'Current password is required' }),
  newPassword: newPassword('New password is required'),
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
  };
}

/** The signed-in customer's own details (design 08, "Details"). */
export class AccountService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auth: AuthService,
  ) {}

  async getProfile(user: User) {
    return toUserProfile(user);
  }

  /**
   * Changing the email needs the current password, and returns a fresh token:
   * tokens are keyed by email, so the old ones stop working.
   */
  async updateProfile(user: User, input: z.output<typeof ProfileUpdateSchema>) {
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
        },
      });
    } catch (e) {
      // Lost a race for the same email or phone.
      if (isIntegrityViolation(e)) {
        throw emailChanged ? new EmailAlreadyRegisteredError(input.email!) : new PhoneAlreadyRegisteredError(phone ?? '');
      }
      throw e;
    }
    return { profile: toUserProfile(updated), auth: emailChanged ? this.auth.issue(updated) : null };
  }

  /** New password; every token issued before now stops working, and a fresh one comes back. */
  async changePassword(user: User, input: z.output<typeof PasswordChangeSchema>) {
    if (!(await checkPassword(input.currentPassword, user.password))) throw new IncorrectPasswordError();
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { password: await hashPassword(input.newPassword), passwordChangedAt: new Date() },
    });
    return this.auth.issue(updated);
  }
}
