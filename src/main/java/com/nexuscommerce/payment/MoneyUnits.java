package com.nexuscommerce.payment;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Set;

/**
 * Conversion between major-unit amounts (e.g. dollars) and the integer minor
 * units payment providers exchange (e.g. cents). Shared by the gateway (charge
 * creation) and the webhook path (validating a provider-reported amount against
 * an order total) so both sides always agree on the conversion.
 */
public final class MoneyUnits {

    /**
     * ISO-4217 currencies that have no minor unit: their amounts are charged as
     * whole numbers, not multiplied by 100. (Stripe's "zero-decimal" set.)
     */
    private static final Set<String> ZERO_DECIMAL_CURRENCIES = Set.of(
            "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG",
            "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF");

    /**
     * Three-decimal currencies (1/1000 minor units). Deliberately UNSUPPORTED:
     * treating them as two-decimal would silently charge one tenth of the price
     * — and the webhook amount validation, using the same conversion, would
     * confirm it. Configuring one fails loudly instead.
     */
    private static final Set<String> UNSUPPORTED_THREE_DECIMAL_CURRENCIES = Set.of(
            "BHD", "JOD", "KWD", "OMR", "TND");

    private MoneyUnits() {
    }

    /**
     * Convert a major-unit amount to integer minor units, honouring zero-decimal
     * currencies. Uses exact conversion so a fractional cent surfaces as an
     * error rather than being silently rounded away.
     */
    public static long toMinorUnits(BigDecimal amount, String currency) {
        String upper = currency.toUpperCase();
        if (UNSUPPORTED_THREE_DECIMAL_CURRENCIES.contains(upper)) {
            throw new IllegalArgumentException(
                    "Three-decimal currency " + upper + " is not supported");
        }
        BigDecimal scaled = ZERO_DECIMAL_CURRENCIES.contains(upper)
                ? amount.setScale(0, RoundingMode.UNNECESSARY)
                : amount.movePointRight(2).setScale(0, RoundingMode.UNNECESSARY);
        return scaled.longValueExact();
    }
}
