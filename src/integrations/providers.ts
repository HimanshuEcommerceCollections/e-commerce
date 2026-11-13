/**
 * Vendor types an admin can connect. A built-in provider has code behind it
 * (Gooten: catalog import and order hand-off); CUSTOM stores any vendor's
 * credentials and can test the connection, ready for an adapter to be written.
 *
 * To add a vendor adapter: add its entry here, then read its credentials with
 * IntegrationService.resolve('<ID>') from the vendor's service.
 */

export interface SecretSpec {
  /** UPPER_SNAKE name the adapter reads. */
  name: string;
  label: string;
  required?: boolean;
  help?: string;
}

export interface SettingSpec {
  key: string;
  label: string;
  type: 'boolean' | 'text' | 'select';
  options?: Array<{ value: string; label: string }>;
  default?: boolean | string;
  help?: string;
}

export interface ProviderSpec {
  id: string;
  label: string;
  description: string;
  /** At most one integration of this provider (its adapter reads "the" one). */
  single: boolean;
  defaultBaseUrl?: string;
  baseUrlRequired: boolean;
  secrets: SecretSpec[];
  /** Admins may add secrets under any name. */
  freeformSecrets: boolean;
  settings: SettingSpec[];
  /** What the integration's tab offers, shown when choosing a provider. */
  features: string[];
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  GOOTEN: {
    id: 'GOOTEN',
    label: 'Gooten',
    description: 'Print-on-demand: import products into the catalog and send orders for Gooten to print and ship.',
    single: true,
    defaultBaseUrl: 'https://api.print.io/api/v/5/source/api',
    baseUrlRequired: true,
    secrets: [
      { name: 'RECIPE_ID', label: 'Recipe ID', required: true, help: 'Reads the Gooten catalog.' },
      { name: 'PARTNER_BILLING_KEY', label: 'Partner billing key', help: 'Needed to send orders; Gooten bills this account.' },
    ],
    freeformSecrets: false,
    settings: [
      {
        key: 'testMode',
        label: 'Test mode',
        type: 'boolean',
        default: true,
        help: 'Gooten checks orders but never prints, ships or bills them.',
      },
    ],
    features: ['Browse and import catalog products', 'Send paid orders for fulfilment', 'Order status refresh'],
  },
  CUSTOM: {
    id: 'CUSTOM',
    label: 'Custom API',
    description: 'Any other vendor: store its credentials and test the connection. Product and order features need an adapter.',
    single: false,
    baseUrlRequired: false,
    secrets: [],
    freeformSecrets: true,
    settings: [
      {
        key: 'authType',
        label: 'How the API key is sent',
        type: 'select',
        default: 'none',
        options: [
          { value: 'none', label: 'Not sent' },
          { value: 'bearer', label: 'Authorization: Bearer <secret>' },
          { value: 'header', label: 'Custom header' },
          { value: 'query', label: 'Query parameter' },
          { value: 'basic', label: 'Basic auth (two secrets: USERNAME, PASSWORD)' },
        ],
      },
      { key: 'authSecret', label: 'Secret to send', type: 'text', help: 'The secret name, e.g. API_KEY.' },
      { key: 'authName', label: 'Header or parameter name', type: 'text', help: 'e.g. X-Api-Key or api_key.' },
      { key: 'testPath', label: 'Connection test path', type: 'text', help: 'GET request relative to the base URL, e.g. /v1/products.' },
    ],
    features: ['Credentials stored encrypted', 'Connection test'],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
