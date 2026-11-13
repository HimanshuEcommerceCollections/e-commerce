import { DomainError } from '../../common/errors';

/**
 * Thin client for Gooten's v5 source API (https://api.print.io/api/v/5/source/api).
 * Every call carries the recipe ID as `recipeid`; only order placement needs
 * the partner billing key, which travels in the order body (Payment).
 *
 * Shapes below were checked against the live API: products, productvariants,
 * shippingprices and the orders validation errors. Gooten answers a rejected
 * request with {HadError: true, Errors: [{PropertyName, ErrorMessage}]}.
 */

export interface GootenMoney {
  Price: number;
  CurrencyCode: string;
  FormattedPrice?: string;
}

export interface GootenImage {
  Url: string;
  Index?: number;
  Id?: number;
  ImageTypes?: string[];
}

export interface GootenInfo {
  Content: string[];
  ContentType: string;
  Key?: string;
  Index?: number;
}

export interface GootenProduct {
  Id: number;
  UId?: string;
  Name: string;
  ShortDescription?: string;
  HasAvailableProductVariants?: boolean;
  IsComingSoon?: boolean;
  RetailPrice?: GootenMoney;
  PriceInfo?: GootenMoney;
  Info?: GootenInfo[];
  Images?: GootenImage[];
  Categories?: Array<{ Id?: number; Name?: string }>;
}

export interface GootenVariantOption {
  OptionId: string;
  ValueId: string;
  Name: string;
  Value: string;
  ImageUrl?: string;
  SortValue?: string;
}

export interface GootenVariant {
  Sku: string;
  Options: GootenVariantOption[];
  PriceInfo: GootenMoney;
  MaxImages?: number;
  HasTemplates?: boolean;
}

export interface GootenShipOption {
  Id: number;
  MethodId?: number;
  MethodType: string;
  Name: string;
  CarrierName?: string;
  Price: GootenMoney;
  EstBusinessDaysTilDelivery?: number;
  MinDays?: number;
  MaxDays?: number;
}

export interface GootenShippingPrices {
  Result: Array<{ SKUs: string[]; ShipOptions: GootenShipOption[] }>;
}

export interface GootenAddress {
  FirstName: string;
  LastName: string;
  Line1: string;
  Line2?: string;
  City: string;
  State: string;
  CountryCode: string;
  PostalCode: string;
  Phone?: string;
  Email?: string;
  IsBusinessAddress?: boolean;
}

export interface GootenOrderRequest {
  ShipToAddress: GootenAddress;
  BillingAddress: GootenAddress;
  Items: Array<{
    Quantity: number;
    SKU: string;
    ShipCarrierMethodId: number;
    SourceId?: string;
    Images: Array<{ Url: string; Index?: number }>;
  }>;
  Payment: { PartnerBillingKey: string };
  IsInTestMode: boolean;
  SourceId?: string;
}

interface GootenErrorBody {
  HadError?: boolean;
  Errors?: Array<{ PropertyName?: string; ErrorMessage?: string }>;
  ErrorReferenceCode?: string;
}

/** Gooten refused the request or could not be reached. Answers 502 to our caller. */
export class GootenApiError extends DomainError {
  constructor(
    message: string,
    readonly body?: unknown,
  ) {
    super(502, message);
  }
}

/** Credentials from the Gooten integration (Admin › Settings › API integrations). */
export interface GootenConnection {
  recipeId: string;
  partnerBillingKey: string;
  testMode: boolean;
  apiBaseUrl: string;
  timeoutMs: number;
}

export class GootenClient {
  constructor(private readonly config: GootenConnection) {}

  get hasRecipe() {
    return this.config.recipeId !== '';
  }

  products(countryCode = 'US', currencyCode = 'USD') {
    return this.get<{ Products: GootenProduct[] }>('products/', { countryCode, currencyCode, languageCode: 'en' });
  }

  productVariants(productId: number, countryCode = 'US', currencyCode = 'USD') {
    return this.get<{ ProductVariants: GootenVariant[] }>('productvariants/', {
      productId: String(productId),
      countryCode,
      currencyCode,
      languageCode: 'en',
    });
  }

  shippingPrices(body: {
    ShipToPostalCode: string;
    ShipToCountry: string;
    ShipToState: string;
    CurrencyCode: string;
    LanguageCode: string;
    Items: Array<{ SKU: string; Quantity: number }>;
  }) {
    return this.send<GootenShippingPrices>('POST', 'shippingprices/', {}, body);
  }

  submitOrder(order: Omit<GootenOrderRequest, 'Payment'>) {
    if (!this.config.partnerBillingKey) {
      throw new DomainError(409, 'Add the partner billing key to the Gooten integration before sending orders');
    }
    const body: GootenOrderRequest = { ...order, Payment: { PartnerBillingKey: this.config.partnerBillingKey } };
    return this.send<{ Id: string }>('POST', 'orders/', {}, body);
  }

  getOrder(id: string) {
    return this.get<Record<string, unknown>>('orders/', { id });
  }

  private get<T>(path: string, query: Record<string, string>) {
    return this.send<T>('GET', path, query);
  }

  private async send<T>(method: 'GET' | 'POST', path: string, query: Record<string, string>, body?: unknown): Promise<T> {
    if (!this.hasRecipe) throw new DomainError(409, 'Add the recipe ID to the Gooten integration');
    const url = new URL(`${this.config.apiBaseUrl}/${path}`);
    url.searchParams.set('recipeid', this.config.recipeId);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new GootenApiError(timedOut ? 'Gooten did not answer in time' : 'Could not reach Gooten');
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new GootenApiError(`Gooten answered ${res.status} with a non-JSON body`);
    }
    const errBody = json as GootenErrorBody | null;
    if (!res.ok || errBody?.HadError) {
      throw new GootenApiError(`Gooten rejected the request: ${describeErrors(errBody, res.status)}`, json);
    }
    return json as T;
  }
}

function describeErrors(body: GootenErrorBody | null, status: number): string {
  const list = (body?.Errors ?? [])
    .map((e) => [e.PropertyName, e.ErrorMessage].filter(Boolean).join(': '))
    .filter(Boolean);
  return list.length ? list.join('; ').slice(0, 1500) : `HTTP ${status}`;
}
