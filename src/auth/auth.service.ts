import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  AccountDisabledError,
  AccountLockedError,
  BadCredentialsError,
  DomainError,
  EmailAlreadyRegisteredError,
  OrderNotFoundError,
  PhoneAlreadyRegisteredError,
} from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { logger } from '../common/logger';
import { flag, optionalString, requiredString } from '../common/validation';
import type { Config } from '../config';
import { TX } from '../db';
import type { Mailer } from '../notify/mailer';
import { normalizeOrderNumber } from '../order/order-number';
import { saveCheckoutAddress } from '../user/address.service';
import type { ClientInfo, SessionService } from '../account/sessions.service';
import { OtpConfirmSchema, type TwoFactorService } from '../account/two-factor.service';
import type { JwtService } from './jwt';

const log = logger('auth');

/** New-password rule everywhere: 8–100 characters with at least one letter and one digit. */
export const newPassword = (blankMessage = 'Password is required') =>
  requiredString({
    blankMessage,
    min: 8,
    max: 100,
    sizeMessage: 'Password must be between 8 and 100 characters',
    pattern: /^(?=.*[A-Za-z])(?=.*\d)/,
    patternMessage: 'Password must contain at least one letter and one digit',
  });

export const emailField = () =>
  requiredString({
    blankMessage: 'Email is required',
    email: true,
    emailMessage: 'Must be a valid email address',
    max: 255,
    sizeMessage: 'Email must not exceed 255 characters',
  });

export const fullNameField = () =>
  requiredString({
    blankMessage: 'Full name is required',
    max: 200,
    sizeMessage: 'Full name must not exceed 200 characters',
  });

/** Optional phone; blank counts as none. */
export const phoneField = () =>
  optionalString({
    pattern: /^$|^[+]?[0-9 ()-]{7,20}$/,
    patternMessage: 'Must be a valid phone number',
    max: 20,
    sizeMessage: 'Phone number must not exceed 20 characters',
  }).transform((v) => (v?.trim() ? v.trim() : undefined));

export const RegisterSchema = z.object({
  email: emailField(),
  password: newPassword(),
  fullName: fullNameField(),
  phoneNumber: phoneField(),
  marketingOptIn: flag(),
});

/** "Keep me signed in": on unless the client sends false. */
const rememberMe = () => z.boolean({ invalid_type_error: 'must be a boolean' }).nullish().transform((v) => v ?? true);

export const LoginSchema = z.object({
  email: requiredString({ blankMessage: 'Email is required', email: true, emailMessage: 'Must be a valid email address' }),
  password: requiredString({ blankMessage: 'Password is required' }),
  rememberMe: rememberMe(),
});

/** Sign-in step two when TWO_FACTOR_ENFORCE=true. */
export const LoginVerifySchema = OtpConfirmSchema.extend({ rememberMe: rememberMe() });

export const PasswordResetRequestSchema = z.object({
  email: requiredString({ blankMessage: 'Email is required', email: true, emailMessage: 'Must be a valid email address', max: 255 }),
});

export const PasswordResetConfirmSchema = z.object({
  token: requiredString({ blankMessage: 'Token is required', max: 200 }),
  newPassword: newPassword(),
});

/** Account from a guest order (design 06): one password field; the name defaults to the ship-to name. */
export const OrderAccountSchema = z.object({
  password: newPassword(),
  fullName: optionalString({ max: 200, sizeMessage: 'Full name must not exceed 200 characters' }),
});

const BCRYPT_ROUNDS = 10; // Spring's BCryptPasswordEncoder default strength
// Compared against when the email is unknown, so both paths cost one bcrypt.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);
export const checkPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

export class InvalidResetTokenError extends DomainError {
  constructor() {
    super(400, 'This password reset link is invalid or has expired. Request a new one.');
  }
}

export function toAuthResponse(token: string, expiresIn: number, user: User) {
  const now = Date.now();
  return {
    accessToken: token,
    tokenType: 'Bearer',
    expiresIn,
    expiresAt: new Date(now + expiresIn).toISOString(),
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    phoneNumber: user.phoneNumber,
    role: user.role,
    issuedAt: new Date(now).toISOString(),
  };
}

export type AuthResponse = ReturnType<typeof toAuthResponse>;

/** Login answer while 2-step verification is enforced: no token until the code checks out. */
export interface TwoFactorChallengeResponse {
  twoFactorRequired: true;
  challengeId: string;
  phoneMasked: string | null;
}

export class AuthService {
  private readonly appBaseUrl: string;
  private readonly storeName: string;
  private readonly resetTtlMinutes: number;
  private readonly rememberLifetimeMs: number;
  private readonly enforceTwoFactor: boolean;

  constructor(
    private readonly db: PrismaClient,
    private readonly jwt: JwtService,
    config: Config,
    private readonly mailer: Mailer,
    private readonly sessions: SessionService,
    private readonly twoFactor: TwoFactorService,
  ) {
    this.appBaseUrl = config.store.appBaseUrl;
    this.storeName = config.store.name;
    this.resetTtlMinutes = config.passwordReset.ttlMinutes;
    this.rememberLifetimeMs = config.jwt.rememberExpirationMs;
    this.enforceTwoFactor = config.twoFactor.enforce;
    this.maxAddresses = config.address.maxPerUser;
  }

  private readonly maxAddresses: number;

  /**
   * A fresh token for this user, for an existing session (sessionId) or none
   * (a legacy token). `rememberMe` picks the 30-day lifetime.
   */
  issue(user: User, options: { sessionId?: string | null; rememberMe?: boolean } = {}): AuthResponse {
    const lifetimeMs = options.rememberMe ? this.rememberLifetimeMs : this.jwt.expirationMs;
    const token = this.jwt.generateToken(user.email, { sessionId: options.sessionId, lifetimeMs });
    return toAuthResponse(token, lifetimeMs, user);
  }

  /** Signs a device in: a new user_sessions row and a token carrying it. */
  async startSession(user: User, client: ClientInfo = {}, rememberMe = true): Promise<AuthResponse> {
    const session = await this.sessions.create(user.id, client);
    return this.issue(user, { sessionId: session.id, rememberMe });
  }

  /** POST /api/auth/logout: the token's session stops working (legacy tokens just expire). */
  async logout(user: User, sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.sessions.revoke(user.id, sessionId);
  }

  /** Step two of an enforced 2-step sign-in. */
  async verifyLogin(input: z.output<typeof LoginVerifySchema>, client: ClientInfo = {}): Promise<AuthResponse> {
    const userId = await this.twoFactor.verifyLogin(input);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.accountNonLocked) throw new AccountLockedError();
    if (!user.enabled) throw new AccountDisabledError();
    await this.db.$executeRaw`UPDATE users SET last_login_at = now() WHERE id = ${user.id}::uuid`;
    return this.startSession(user, client, input.rememberMe);
  }

  /** Public self-registration: always ROLE_CUSTOMER, and returns a token straight away. */
  async register(input: z.output<typeof RegisterSchema>, client: ClientInfo = {}) {
    if (await this.db.user.findUnique({ where: { email: input.email } })) {
      throw new EmailAlreadyRegisteredError(input.email);
    }
    if (input.phoneNumber && (await this.db.user.findUnique({ where: { phoneNumber: input.phoneNumber } }))) {
      throw new PhoneAlreadyRegisteredError(input.phoneNumber);
    }
    const user = await this.db.user.create({
      data: {
        email: input.email,
        password: await hashPassword(input.password),
        fullName: input.fullName,
        phoneNumber: input.phoneNumber ?? null,
        marketingOptIn: input.marketingOptIn,
        role: 'ROLE_CUSTOMER',
      },
    });
    await this.welcome(user);
    return this.startSession(user, client);
  }

  /**
   * Account-status checks run before the password check, in Spring's order
   * (locked, then disabled). With TWO_FACTOR_ENFORCE=true an enrolled
   * customer gets a challenge instead of a token (finish at /login/verify).
   */
  async login(input: z.output<typeof LoginSchema>, client: ClientInfo = {}): Promise<AuthResponse | TwoFactorChallengeResponse> {
    const user = await this.db.user.findUnique({ where: { email: input.email } });
    if (!user) {
      await bcrypt.compare(input.password, DUMMY_HASH);
      throw new BadCredentialsError();
    }
    if (!user.accountNonLocked) throw new AccountLockedError();
    if (!user.enabled) throw new AccountDisabledError();
    if (!(await checkPassword(input.password, user.password))) throw new BadCredentialsError();

    if (this.enforceTwoFactor && user.twoFactorEnabled && (user.twoFactorPhone || user.phoneNumber)) {
      const challenge = await this.twoFactor.startLogin(user);
      return { twoFactorRequired: true, ...challenge };
    }
    // Raw update: last_login_at only, leaving updated_at alone (as the Java query did).
    await this.db.$executeRaw`UPDATE users SET last_login_at = now() WHERE id = ${user.id}::uuid`;
    return this.startSession(user, client, input.rememberMe);
  }

  // ── Password reset ───────────────────────────────────────────────────────

  /**
   * Emails a single-use reset link when the account exists. The caller always
   * gets the same answer, so the form can't be used to discover accounts.
   * Only the token's SHA-256 is stored; a new request voids older links.
   */
  async requestPasswordReset(input: z.output<typeof PasswordResetRequestSchema>) {
    const user = await this.db.user.findFirst({
      where: { email: { equals: input.email.trim(), mode: 'insensitive' }, deleted: false },
    });
    if (!user || !user.enabled) {
      log.info('Password reset requested for an unknown or disabled account');
      return;
    }
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.db.$transaction([
      this.db.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } }),
      this.db.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(now.getTime() + this.resetTtlMinutes * 60_000),
        },
      }),
    ]);
    const link = `${this.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      template: 'PASSWORD_RESET',
      to: user.email,
      userId: user.id,
      subject: `${this.storeName}: reset your password`,
      body:
        `Someone asked to reset the password for your ${this.storeName} account.\n\n` +
        `Choose a new password here (the link works once, for ${this.resetTtlMinutes} minutes):\n${link}\n\n` +
        `If it wasn't you, ignore this email: your password stays the same.`,
    });
  }

  /** Sets the new password with a valid link, signs out other sessions and signs this one in. */
  async confirmPasswordReset(input: z.output<typeof PasswordResetConfirmSchema>, client: ClientInfo = {}) {
    const user = await this.db.$transaction(async (tx) => {
      const row = await tx.passwordResetToken.findUnique({ where: { tokenHash: sha256Hex(input.token.trim()) } });
      if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) throw new InvalidResetTokenError();
      // Single use, even against a concurrent second submit.
      const { count } = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (count === 0) throw new InvalidResetTokenError();
      return tx.user.update({
        where: { id: row.userId },
        data: { password: await hashPassword(input.newPassword), passwordChangedAt: new Date() },
      });
    }, TX.default);
    if (!user.enabled) throw new AccountDisabledError();
    if (!user.accountNonLocked) throw new AccountLockedError();
    // passwordChangedAt already refuses older tokens; this keeps the device list honest.
    await this.sessions.revokeOthers(user.id, null);
    return this.startSession(user, client);
  }

  // ── Account from a guest order ───────────────────────────────────────────

  /**
   * Turns a guest checkout into an account (design 06): the order's email,
   * the chosen password, and the order linked to the new account. 409 when
   * the email already has an account — the client offers sign-in instead.
   */
  async createAccountFromGuestOrder(
    orderNumber: string,
    token: string | undefined,
    input: z.output<typeof OrderAccountSchema>,
    client: ClientInfo = {},
  ) {
    const order = token
      ? await this.db.order.findFirst({
          where: { orderNumber: normalizeOrderNumber(orderNumber), guestTokenHash: sha256Hex(token), deleted: false },
        })
      : null;
    if (!order || !order.customerEmail) throw new OrderNotFoundError(orderNumber);
    const email = order.customerEmail;
    if (order.userId || (await this.db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } }))) {
      throw new EmailAlreadyRegisteredError(email);
    }

    const password = await hashPassword(input.password);
    let user: User;
    try {
      user = await this.db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            password,
            fullName: input.fullName?.trim() || order.shipRecipientName,
            marketingOptIn: order.marketingOptIn,
            role: 'ROLE_CUSTOMER',
          },
        });
        const { count } = await tx.order.updateMany({
          where: { id: order.id, userId: null },
          data: { userId: created.id },
        });
        if (count === 0) throw new EmailAlreadyRegisteredError(email);
        // The order's ship-to becomes the new account's default address (contract B5).
        await saveCheckoutAddress(
          tx,
          created.id,
          {
            recipientName: order.shipRecipientName,
            phone: order.shipPhone,
            addressLine1: order.shipAddressLine1,
            addressLine2: order.shipAddressLine2,
            city: order.shipCity,
            state: order.shipState,
            postalCode: order.shipPostalCode,
            country: order.shipCountry,
          },
          this.maxAddresses,
        );
        return created;
      }, TX.default);
    } catch (e) {
      // Two submits at once: uk_users_email lets one through.
      if (isIntegrityViolation(e)) throw new EmailAlreadyRegisteredError(email);
      throw e;
    }
    await this.welcome(user);
    return this.startSession(user, client);
  }

  private welcome(user: User) {
    return this.mailer.send({
      template: 'ACCOUNT_CREATED',
      to: user.email,
      userId: user.id,
      subject: `Welcome to ${this.storeName}`,
      body:
        `Hi ${user.fullName}, your ${this.storeName} account is ready.\n\n` +
        `See your orders and saved addresses any time: ${this.appBaseUrl}/account`,
    });
  }
}
