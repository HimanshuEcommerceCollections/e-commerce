/**
 * Application errors. Each carries the HTTP status it maps to; the single
 * error handler renders any subclass as an ApiResponse. Messages are the Java
 * server's, word for word — clients and tests match on them.
 */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

const bad = 400;
const notFound = 404;
const conflict = 409;

// ── auth ────────────────────────────────────────────────────────────────────
export class EmailAlreadyRegisteredError extends DomainError {
  constructor(email: string) {
    super(conflict, `An account is already registered for: ${email}`);
  }
}
export class PhoneAlreadyRegisteredError extends DomainError {
  constructor(phone: string) {
    super(conflict, `An account is already registered for phone: ${phone}`);
  }
}
export class BadCredentialsError extends DomainError {
  constructor() {
    super(401, 'Invalid email or password');
  }
}
export class AccountDisabledError extends DomainError {
  constructor() {
    super(403, 'This account has been disabled');
  }
}
export class AccountLockedError extends DomainError {
  constructor() {
    super(403, 'This account is temporarily locked');
  }
}
export class AuthenticationRequiredError extends DomainError {
  constructor() {
    super(401, 'Authentication required');
  }
}
export class AccessDeniedError extends DomainError {
  constructor() {
    super(403, 'You do not have permission to perform this action');
  }
}

// ── addresses ───────────────────────────────────────────────────────────────
export class AddressNotFoundError extends DomainError {
  constructor(id: string) {
    super(notFound, `Address not found: ${id}`);
  }
}
export class AddressLimitExceededError extends DomainError {
  constructor(limit: number) {
    super(bad, `You can save a maximum of ${limit} addresses per account`);
  }
}

// ── catalog ─────────────────────────────────────────────────────────────────
export class CategoryNotFoundError extends DomainError {
  constructor(id: string) {
    super(notFound, `Category not found: ${id}`);
  }
}
export class SlugAlreadyExistsError extends DomainError {
  constructor(slug: string) {
    super(conflict, `A category with slug '${slug}' already exists`);
  }
}
export class ProductNotFoundError extends DomainError {
  constructor(id: string) {
    super(notFound, `Product not found: ${id}`);
  }
}
export class SkuAlreadyExistsError extends DomainError {
  constructor(sku: string) {
    super(conflict, `A product with SKU '${sku}' already exists`);
  }
}
export class ParentProductNotFoundError extends DomainError {
  constructor(code: string) {
    super(notFound, `Parent product not found: ${code}`);
  }
}
export class VariantCategoryMismatchError extends DomainError {
  constructor(parentCode: string) {
    super(bad, `Category must match the category of parent product '${parentCode}'`);
  }
}
export class InvalidImportFileError extends DomainError {
  constructor(message: string) {
    super(bad, message);
  }
}

// ── cart ────────────────────────────────────────────────────────────────────
export class CartItemNotFoundError extends DomainError {
  constructor(productId: string) {
    super(notFound, `Cart item not found for product: ${productId}`);
  }
}
export class InsufficientStockError extends DomainError {
  constructor(available: number, requested: number) {
    super(bad, `Only ${available} units available, but ${requested} requested`);
  }
}
export class ProductNotAvailableError extends DomainError {
  constructor(productId: string) {
    super(bad, `Product ${productId} is not available for purchase`);
  }
}

// ── orders ──────────────────────────────────────────────────────────────────
export class EmptyCartError extends DomainError {
  constructor() {
    super(bad, 'Your cart is empty');
  }
}
export class IdempotencyKeyConflictError extends DomainError {
  constructor() {
    super(422, 'This Idempotency-Key was already used with a different request. Use a new key.');
  }
}
export class InvalidIdempotencyKeyError extends DomainError {
  constructor() {
    super(bad, "Idempotency-Key must be 1-80 characters of letters, digits, '-' or '_'");
  }
}
export class InvalidOrderStateError extends DomainError {
  constructor(message: string) {
    super(conflict, message);
  }
}
export class OrderNotFoundError extends DomainError {
  constructor(id: string) {
    super(notFound, `Order ${id} was not found`);
  }
}
/** Stock ran out between add-to-cart and checkout (a concurrent buyer won the last units). */
export class OutOfStockError extends DomainError {
  constructor(productName: string) {
    super(conflict, `Insufficient stock for '${productName}'`);
  }
}
export class ProductUnavailableError extends DomainError {
  constructor(productId: string) {
    super(conflict, `Product ${productId} is no longer available for purchase`);
  }
}

// ── payments ────────────────────────────────────────────────────────────────
export class PaymentGatewayError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super(502, message);
    this.cause = cause;
  }
}
export class WebhookVerificationError extends DomainError {
  constructor(message: string) {
    super(bad, message);
  }
}
export class WebhookEventNotFoundError extends DomainError {
  constructor(eventId: string) {
    super(notFound, `Webhook event not found: ${eventId}`);
  }
}
export class WebhookEventNotReplayableError extends DomainError {
  constructor(eventId: string, reason: string) {
    super(conflict, `Webhook event ${eventId} cannot be replayed: ${reason}`);
  }
}
/**
 * A provider-reported payment doesn't match the order total or currency.
 * Never an HTTP error: thrown during webhook dispatch so the event is stored
 * FAILED (replayable) instead of confirming a wrong amount.
 */
export class PaymentAmountMismatchError extends Error {
  constructor(orderNumber: string, expected: bigint, actual: bigint, expectedCur: string, actualCur: string) {
    super(
      `Payment amount mismatch for order ${orderNumber}: expected ${expected} ${expectedCur}, ` +
        `provider reported ${actual} ${actualCur}`,
    );
    this.name = 'PaymentAmountMismatchError';
  }
}

// ── generic ─────────────────────────────────────────────────────────────────
/** Concurrent write lost an optimistic-lock race (was ObjectOptimisticLockingFailureException). */
export class ConcurrentUpdateError extends DomainError {
  constructor() {
    super(conflict, 'This resource was updated by another request. Please retry.');
  }
}
