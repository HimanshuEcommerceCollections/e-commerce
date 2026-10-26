import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';
import { z } from 'zod';
import { optionalString, requiredString, ValidationError } from '../common/validation';
import type { Mailer } from '../notify/mailer';

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;

export const NO_PHONE_MESSAGE = 'Add a mobile number in Profile first.';
const WRONG_CODE_MESSAGE = "That code didn't match. Try again.";
const EXPIRED_MESSAGE = 'That code has expired. Request a new one.';
const TOO_MANY_MESSAGE = 'Too many tries. Request a new code.';

export const TwoFactorStartSchema = z.object({
  phone: optionalString({
    pattern: /^$|^[+]?[0-9 ()-]{7,20}$/,
    patternMessage: 'Enter a valid mobile number.',
    max: 20,
    sizeMessage: 'Enter a valid mobile number.',
  }),
});

export const OtpConfirmSchema = z.object({
  challengeId: requiredString({ blankMessage: 'challengeId is required', max: 64 }),
  code: requiredString({ blankMessage: 'Enter the 6-digit code.', max: 12 }),
});

/** "•••-•••-4821": only the last four digits ever leave the server. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return `•••-•••-${digits.slice(-4)}`;
}

type Purpose = 'ENROLL' | 'LOGIN';

/**
 * 2-step verification by text message (design 08, "Sign-in & security").
 * There is no SMS provider yet: codes go through the log-only mailer as an
 * OTP_CODE notification addressed to the phone. Only a hash of each code is
 * stored; a code lives ten minutes and allows five tries.
 */
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly mailer: Mailer,
    private readonly storeName: string,
  ) {}

  /** Sends an enrolment code to `phone` (default: the profile phone). */
  async start(user: User, input: z.output<typeof TwoFactorStartSchema>) {
    const phone = input.phone?.trim() || user.phoneNumber;
    if (!phone) throw new ValidationError({ phone: NO_PHONE_MESSAGE });
    return this.send(user, phone, 'ENROLL');
  }

  /** Checks the enrolment code and turns 2-step verification on for that phone. */
  async confirm(user: User, input: z.output<typeof OtpConfirmSchema>): Promise<User> {
    const challenge = await this.consume(user.id, input, 'ENROLL');
    return this.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true, twoFactorPhone: challenge.phone },
    });
  }

  async disable(user: User): Promise<User> {
    return this.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorPhone: null },
    });
  }

  /** Sign-in step two (TWO_FACTOR_ENFORCE=true): a code to the enrolled phone. */
  async startLogin(user: User) {
    return this.send(user, user.twoFactorPhone ?? user.phoneNumber ?? '', 'LOGIN');
  }

  /** The user id a LOGIN challenge was for, once its code checks out. */
  async verifyLogin(input: z.output<typeof OtpConfirmSchema>): Promise<string> {
    return (await this.consume(null, input, 'LOGIN')).userId;
  }

  private async send(user: User, phone: string, purpose: Purpose) {
    const id = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    await this.prisma.otpChallenge.create({
      data: {
        id,
        userId: user.id,
        purpose,
        phone,
        codeHash: codeHash(id, code),
        expiresAt: new Date(now + OTP_TTL_MINUTES * 60_000),
      },
    });
    await this.mailer.send({
      template: 'OTP_CODE',
      to: phone,
      userId: user.id,
      subject: `${this.storeName} verification code`,
      body: `${code} is your ${this.storeName} verification code. It expires in ${OTP_TTL_MINUTES} minutes. Don't share it with anyone.`,
    });
    return { challengeId: id, phoneMasked: maskPhone(phone) };
  }

  /**
   * Marks the challenge used when the code matches. Every wrong try counts,
   * and the fifth wrong one (or expiry) ends the challenge. Wrong user, wrong
   * purpose and unknown ids all look like a wrong code.
   */
  private async consume(userId: string | null, input: z.output<typeof OtpConfirmSchema>, purpose: Purpose) {
    const id = input.challengeId.trim();
    const row = /^[0-9a-f-]{36}$/i.test(id) ? await this.prisma.otpChallenge.findUnique({ where: { id } }) : null;
    if (!row || row.purpose !== purpose || (userId !== null && row.userId !== userId) || row.consumedAt) {
      throw new ValidationError({ code: WRONG_CODE_MESSAGE });
    }
    if (row.expiresAt.getTime() <= Date.now()) throw new ValidationError({ code: EXPIRED_MESSAGE });
    if (row.attempts >= OTP_MAX_ATTEMPTS) throw new ValidationError({ code: TOO_MANY_MESSAGE });

    const given = Buffer.from(codeHash(row.id, input.code.replace(/\s/g, '')), 'hex');
    if (!timingSafeEqual(given, Buffer.from(row.codeHash, 'hex'))) {
      const { attempts } = await this.prisma.otpChallenge.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });
      throw new ValidationError({ code: attempts >= OTP_MAX_ATTEMPTS ? TOO_MANY_MESSAGE : WRONG_CODE_MESSAGE });
    }
    // Single use, even against a concurrent second submit.
    const { count } = await this.prisma.otpChallenge.updateMany({
      where: { id: row.id, consumedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
      data: { consumedAt: new Date() },
    });
    if (count === 0) throw new ValidationError({ code: WRONG_CODE_MESSAGE });
    return row;
  }
}

/** Bound to the challenge, so equal codes on two challenges hash differently. */
const codeHash = (challengeId: string, code: string) => createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
