/**
 * A shipping integration (FR-IN-03). The admin "Create shipment" action calls
 * `createShipment`; the provider buys or records the label and returns a
 * trackable reference. Only `manual` exists for now (the operator books the
 * parcel with the carrier and types in the tracking number); a carrier or
 * aggregator API slots in behind the same interface, chosen by SHIPPING_PROVIDER.
 */
export interface ShipmentRequest {
  orderNumber: string;
  /** Free text from the admin; blank lets the provider choose or infer it. */
  carrier?: string;
  service?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shipTo: {
    name: string;
    phone: string | null;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  items: { sku: string; quantity: number }[];
}

export interface ShipmentLabel {
  carrier: string;
  service: string | null;
  trackingNumber: string;
  trackingUrl: string | null;
  labelUrl: string | null;
  /** The provider's own id for the shipment (to void a label or poll tracking). */
  providerReference: string | null;
}

export interface ShippingProvider {
  /** Stored in shipments.provider. */
  readonly name: string;
  createShipment(request: ShipmentRequest): Promise<ShipmentLabel>;
}
