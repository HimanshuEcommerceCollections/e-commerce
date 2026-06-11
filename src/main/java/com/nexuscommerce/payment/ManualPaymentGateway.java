package com.nexuscommerce.payment;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.Optional;
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

    /**
     * No money moved through this gateway, so a "refund" is purely an order-state
     * affair — the operator returns the funds out-of-band. The generated
     * reference keeps the log trail consistent with the real gateway.
     */
    @Override
    public String refund(String paymentReference, BigDecimal amount, String currency) {
        return "MANUAL-REFUND-" + UUID.randomUUID();
    }

    /** Nothing to cancel provider-side; always succeeds. */
    @Override
    public boolean cancelPayment(String paymentReference) {
        return true;
    }

    /** Manual payments never have a client-side secret. */
    @Override
    public Optional<String> findClientSecret(String paymentReference) {
        return Optional.empty();
    }

    // supportsAutomaticExpiry stays false (interface default): manual orders
    // legitimately rest in PENDING_PAYMENT until an admin confirms them.
}
