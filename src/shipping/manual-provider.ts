import { randomInt } from 'node:crypto';
import type { ShipmentLabel, ShipmentRequest, ShippingProvider } from './shipping-provider';
import { canonicalCarrier, detectCarrier, trackingUrlFor } from './tracking';

/**
 * SHIPPING_PROVIDER=manual: the operator books the parcel with the carrier
 * themselves and records it here. Nothing is called; a blank tracking number
 * gets a `MAN-…` reference so the order is still trackable in our own pages.
 */
export class ManualShippingProvider implements ShippingProvider {
  readonly name = 'manual';

  async createShipment(request: ShipmentRequest): Promise<ShipmentLabel> {
    const given = request.trackingNumber?.trim();
    const trackingNumber = given ? given.replace(/\s+/g, '').toUpperCase() : manualReference();
    const typed = request.carrier?.trim();
    const carrier = typed ? canonicalCarrier(typed) : given ? (detectCarrier(trackingNumber) ?? 'Manual') : 'Manual';
    const trackingUrl =
      request.trackingUrl?.trim() || (given ? trackingUrlFor(typed ? carrier : null, trackingNumber) : null);
    return {
      carrier,
      service: request.service?.trim() || null,
      trackingNumber,
      trackingUrl,
      labelUrl: null,
      providerReference: null,
    };
  }
}

/** MAN- + 10 digits, e.g. MAN-4821907315. */
function manualReference() {
  return `MAN-${String(randomInt(1_000_000_000, 10_000_000_000))}`;
}
