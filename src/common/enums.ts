// Values stored in varchar status columns. The first block matches the Java
// enums; the rest arrived with the storefront/operations build.

/** ROLE_CATALOG: catalog staff — products, variants, inventory, imports; no orders or settings (FR-AD-08). */
export const USER_ROLES = ['ROLE_CUSTOMER', 'ROLE_MERCHANT', 'ROLE_ADMIN', 'ROLE_CATALOG'] as const;
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

export const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Who cancelled an order — recorded with the reason so every cancellation is auditable. */
export type CancellationActor = 'CUSTOMER' | 'ADMIN' | 'SYSTEM_EXPIRY' | 'GATEWAY';

export type WebhookEventStatus = 'RECEIVED' | 'PROCESSED' | 'FAILED';

/** orders.fulfilment_status: null until paid, then UNFULFILLED → … → DELIVERED. */
export const FULFILMENT_STATUSES = ['UNFULFILLED', 'PICKED', 'PACKED', 'SHIPPED', 'DELIVERED'] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

/** shipments.status and shipment_events.status. */
export const SHIPMENT_STATUSES = [
  'LABEL_CREATED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'EXCEPTION',
  'RETURNED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const RETURN_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUNDED'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const RETURN_METHODS = ['DROPOFF', 'PICKUP'] as const;
export type ReturnMethod = (typeof RETURN_METHODS)[number];

export const RETURN_REQUESTERS = ['CUSTOMER', 'ADMIN'] as const;
export type ReturnRequester = (typeof RETURN_REQUESTERS)[number];

export const SHIPPING_METHODS = ['STANDARD', 'EXPRESS'] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

/** SELLER: a seller's own stock update, applied without review and audited here. */
export const STOCK_MOVEMENT_SOURCES = ['ADJUSTMENT', 'BULK_UPDATE', 'IMPORT', 'RETURN', 'ORDER', 'CANCELLATION', 'SELLER'] as const;
export type StockMovementSource = (typeof STOCK_MOVEMENT_SOURCES)[number];

/** PURCHASE is server-written when an order becomes PAID; the rest come from the browser. */
export const ANALYTICS_EVENT_TYPES = ['PRODUCT_VIEW', 'ADD_TO_CART', 'CHECKOUT_START', 'SEARCH', 'PURCHASE'] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];
export const CLIENT_ANALYTICS_EVENT_TYPES = ['PRODUCT_VIEW', 'ADD_TO_CART', 'CHECKOUT_START', 'SEARCH'] as const;

export const NOTIFICATION_TEMPLATES = [
  'ORDER_CONFIRMATION',
  'PAYMENT_RECEIVED',
  'ORDER_SHIPPED',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
  'RETURN_REQUESTED',
  'RETURN_UPDATE',
  'REFUND_ISSUED',
  'PASSWORD_RESET',
  'ACCOUNT_CREATED',
  'SUPPORT_TICKET',
  'SELLER_APPLICATION',
  'SUBMISSION_UPDATE',
] as const;
export type NotificationTemplate = (typeof NOTIFICATION_TEMPLATES)[number];

export const NOTIFICATION_STATUSES = ['LOGGED', 'SENT', 'FAILED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const IMAGE_CHECK_STATUSES = ['OK', 'BROKEN', 'UNCHECKED'] as const;
export type ImageCheckStatus = (typeof IMAGE_CHECK_STATUSES)[number];

/** product_submissions.kind: a new product, a change to a live one, or taking one off sale. */
export const SUBMISSION_KINDS = ['NEW_PRODUCT', 'EDIT', 'DELIST'] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

/** product_submissions.status. The first three are open; a product has at most one open submission. */
export const SUBMISSION_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
export const OPEN_SUBMISSION_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED'] as const satisfies readonly SubmissionStatus[];

/** What the seller sees for a product (seller portal flow, page 2). */
export const LISTING_STATES = [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'LIVE',
  'CHANGE_PENDING',
  'SUSPENDED',
  'ARCHIVED',
] as const;
export type ListingState = (typeof LISTING_STATES)[number];
