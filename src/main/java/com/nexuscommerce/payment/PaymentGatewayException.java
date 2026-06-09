package com.nexuscommerce.payment;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

/**
 * The payment provider could not be reached or rejected the request while
 * starting a charge (e.g. a Stripe API error during PaymentIntent creation).
 *
 * <p>Maps to {@code 502 Bad Gateway} — the failure is upstream, not in the
 * caller's request.
 */
public class PaymentGatewayException extends DomainException {
    public PaymentGatewayException(String message, Throwable cause) {
        super(HttpStatus.BAD_GATEWAY, message);
        initCause(cause);
    }
}
