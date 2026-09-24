// Values stored in varchar status columns — identical to the Java enums.

export const USER_ROLES = ['ROLE_CUSTOMER', 'ROLE_MERCHANT', 'ROLE_ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'CONFIRMED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'PAYMENT_FAILED',
  'REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Who cancelled an order — recorded with the reason so every cancellation is auditable. */
export type CancellationActor = 'CUSTOMER' | 'ADMIN' | 'SYSTEM_EXPIRY' | 'GATEWAY';

export type WebhookEventStatus = 'RECEIVED' | 'PROCESSED' | 'FAILED';
