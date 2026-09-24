import type { User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  AccountDisabledError,
  AccountLockedError,
  BadCredentialsError,
  EmailAlreadyRegisteredError,
  PhoneAlreadyRegisteredError,
} from '../common/errors';
import { requiredString } from '../common/validation';
import type { Db } from '../db';
import type { JwtService } from './jwt';

export const RegisterSchema = z.object({
  email: requiredString({
    blankMessage: 'Email is required',
    email: true,
    emailMessage: 'Must be a valid email address',
    max: 255,
    sizeMessage: 'Email must not exceed 255 characters',
  }),
  password: requiredString({
    blankMessage: 'Password is required',
    min: 8,
    max: 100,
    sizeMessage: 'Password must be between 8 and 100 characters',
  }),
  fullName: requiredString({
    blankMessage: 'Full name is required',
    max: 200,
    sizeMessage: 'Full name must not exceed 200 characters',
  }),
  phoneNumber: requiredString({
    blankMessage: 'Phone number is required',
    pattern: /^[+]?[0-9 ()-]{7,20}$/,
    patternMessage: 'Must be a valid phone number',
    max: 20,
    sizeMessage: 'Phone number must not exceed 20 characters',
  }),
});

export const LoginSchema = z.object({
  email: requiredString({ blankMessage: 'Email is required', email: true, emailMessage: 'Must be a valid email address' }),
  password: requiredString({ blankMessage: 'Password is required' }),
});

const BCRYPT_ROUNDS = 10; // Spring's BCryptPasswordEncoder default strength
// Compared against when the email is unknown, so both paths cost one bcrypt.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

export function toAuthResponse(token: string, expiresIn: number, user: User) {
  return {
    accessToken: token,
    tokenType: 'Bearer',
    expiresIn,
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    phoneNumber: user.phoneNumber,
    role: user.role,
    issuedAt: new Date().toISOString(),
  };
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  /** Public self-registration: always ROLE_CUSTOMER, and returns a token straight away. */
  async register(input: z.output<typeof RegisterSchema>) {
    if (await this.db.user.findUnique({ where: { email: input.email } })) {
      throw new EmailAlreadyRegisteredError(input.email);
    }
    if (await this.db.user.findUnique({ where: { phoneNumber: input.phoneNumber } })) {
      throw new PhoneAlreadyRegisteredError(input.phoneNumber);
    }
    const user = await this.db.user.create({
      data: {
        email: input.email,
        password: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
        fullName: input.fullName,
        phoneNumber: input.phoneNumber,
        role: 'ROLE_CUSTOMER',
      },
    });
    return toAuthResponse(this.jwt.generateToken(user.email), this.jwt.expirationMs, user);
  }

  /**
   * Account-status checks run before the password check, in Spring's order
   * (locked, then disabled).
   */
  async login(input: z.output<typeof LoginSchema>) {
    const user = await this.db.user.findUnique({ where: { email: input.email } });
    if (!user) {
      await bcrypt.compare(input.password, DUMMY_HASH);
      throw new BadCredentialsError();
    }
    if (!user.accountNonLocked) throw new AccountLockedError();
    if (!user.enabled) throw new AccountDisabledError();
    if (!(await bcrypt.compare(input.password, user.password))) throw new BadCredentialsError();

    // Raw update: last_login_at only, leaving updated_at alone (as the Java query did).
    await this.db.$executeRaw`UPDATE users SET last_login_at = now() WHERE id = ${user.id}::uuid`;
    return toAuthResponse(this.jwt.generateToken(user.email), this.jwt.expirationMs, user);
  }
}
