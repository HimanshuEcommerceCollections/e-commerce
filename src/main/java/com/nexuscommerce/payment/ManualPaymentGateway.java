package com.nexuscommerce.payment;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * Placeholder gateway used when no real provider is configured. It does not move
 * money: it simply marks the payment {@code PENDING} and hands back a generated
 * reference. The order then waits in PENDING_PAYMENT until an operator confirms
 * it (see the admin "mark paid" endpoint), which stands in for a provider's
 * webhook callback.
 *
 * <p>This is the default {@link PaymentGateway} bean: it is active when
 * {@code app.payment.provider} is {@code manual} or unset. Setting the property
 * to {@code stripe} activates {@link StripePaymentGateway} instead — the two
 * conditions are mutually exclusive, so exactly one bean exists.
 */
@Service
@ConditionalOnProperty(name = "app.payment.provider", havingValue = "manual", matchIfMissing = true)
public class ManualPaymentGateway implements PaymentGateway {

    @Override
    public PaymentInitiation initiate(PaymentRequest request) {
        String reference = "MANUAL-" + UUID.randomUUID();
        // No client secret: there is nothing for the client to confirm in-app yet.
        return new PaymentInitiation(PaymentStatus.PENDING, reference, null);
    }
}
