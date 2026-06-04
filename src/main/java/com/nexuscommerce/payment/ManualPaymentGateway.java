package com.nexuscommerce.payment;

import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * Placeholder gateway used until Stripe is integrated. It does not move money:
 * it simply marks the payment {@code PENDING} and hands back a generated
 * reference. The order then waits in PENDING_PAYMENT until an operator confirms
 * it (see the admin "mark paid" endpoint), which stands in for the future
 * Stripe webhook callback.
 *
 * <p>This is the default {@link PaymentGateway} bean. When a Stripe implementation
 * is added, mark this one {@code @ConditionalOnMissingBean} or guard it behind a
 * profile so Stripe takes precedence in real environments.
 */
@Service
public class ManualPaymentGateway implements PaymentGateway {

    @Override
    public PaymentInitiation initiate(PaymentRequest request) {
        String reference = "MANUAL-" + UUID.randomUUID();
        // No client secret: there is nothing for the client to confirm in-app yet.
        return new PaymentInitiation(PaymentStatus.PENDING, reference, null);
    }
}
