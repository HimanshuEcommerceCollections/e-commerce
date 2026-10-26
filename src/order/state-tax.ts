/**
 * US state base sales-tax rates (percent) for destination-based tax
 * (TAX_MODE=destination). State-level rates only: county and city surtaxes
 * are not modelled, so this is an estimate a tax service would refine. A SKU's
 * own tax rate still wins (see effectiveTaxRate in pricing.ts).
 */
export const STATE_TAX_RATES: Readonly<Record<string, string>> = {
  AL: '4.00', AK: '0.00', AZ: '5.60', AR: '6.50', CA: '7.25', CO: '2.90', CT: '6.35', DE: '0.00',
  DC: '6.00', FL: '6.00', GA: '4.00', HI: '4.00', ID: '6.00', IL: '6.25', IN: '7.00', IA: '6.00',
  KS: '6.50', KY: '6.00', LA: '4.45', ME: '5.50', MD: '6.00', MA: '6.25', MI: '6.00', MN: '6.875',
  MS: '7.00', MO: '4.225', MT: '0.00', NE: '5.50', NV: '6.85', NH: '0.00', NJ: '6.625', NM: '4.875',
  NY: '4.00', NC: '4.75', ND: '5.00', OH: '5.75', OK: '4.50', OR: '0.00', PA: '6.00', RI: '7.00',
  SC: '6.00', SD: '4.20', TN: '7.00', TX: '6.25', UT: '6.10', VT: '6.00', VA: '5.30', WA: '6.50',
  WV: '6.00', WI: '5.00', WY: '4.00',
};

/** The 50 states and DC, by name, for addresses typed with the full name. */
const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/** Two-letter code for a state code or name ("or", "Oregon" → "OR"); null when it is neither. */
export function stateCode(state: string | null | undefined): string | null {
  if (!state) return null;
  const t = state.trim();
  const upper = t.toUpperCase();
  if (upper in STATE_TAX_RATES) return upper;
  return STATE_NAMES[t.toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

export const isUsState = (state: string | null | undefined) => stateCode(state) !== null;

/** Base rate for a destination state, or null when the state is unknown. */
export function stateTaxRate(state: string | null | undefined): string | null {
  const code = stateCode(state);
  return code ? STATE_TAX_RATES[code] : null;
}
