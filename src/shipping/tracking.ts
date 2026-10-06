/**
 * Carrier detection and public tracking links for the big US carriers, so a
 * typed-in tracking number becomes a link the customer can follow (FR-IN-04).
 */

interface CarrierRule {
  carrier: string;
  /** Lower-case names an admin might type. */
  aliases: string[];
  pattern: RegExp;
  url: (trackingNumber: string) => string;
}

const RULES: CarrierRule[] = [
  {
    carrier: 'UPS',
    aliases: ['ups', 'united parcel service'],
    pattern: /^1Z[0-9A-Z]{16}$/,
    url: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  },
  {
    carrier: 'USPS',
    aliases: ['usps', 'us postal service', 'united states postal service'],
    // IMpb (20–22 digits starting 9x) or an international S10 id (EA123456789US).
    pattern: /^(9[2-5]\d{18,20}|[A-Z]{2}\d{9}US)$/,
    url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  },
  {
    carrier: 'FedEx',
    aliases: ['fedex', 'federal express'],
    pattern: /^(\d{12}|\d{15}|\d{20})$/,
    url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  },
];

const normalize = (trackingNumber: string) => trackingNumber.replace(/\s+/g, '').toUpperCase();

/** The carrier a tracking number's format belongs to, or null. */
export function detectCarrier(trackingNumber: string): string | null {
  const n = normalize(trackingNumber);
  return RULES.find((r) => r.pattern.test(n))?.carrier ?? null;
}

/** The canonical carrier name for what an admin typed ("ups" → "UPS"); unknown names are kept. */
export function canonicalCarrier(carrier: string): string {
  const lower = carrier.trim().toLowerCase();
  return RULES.find((r) => r.aliases.includes(lower))?.carrier ?? carrier.trim();
}

/**
 * Public tracking page for a known carrier, else null. A named carrier wins
 * over the number's format (a 12-digit number is FedEx-shaped but could be
 * anything); without a name the format decides.
 */
export function trackingUrlFor(carrier: string | null, trackingNumber: string): string | null {
  const n = normalize(trackingNumber);
  const rule = carrier
    ? RULES.find((r) => r.carrier === canonicalCarrier(carrier))
    : RULES.find((r) => r.pattern.test(n));
  return rule ? rule.url(n) : null;
}
