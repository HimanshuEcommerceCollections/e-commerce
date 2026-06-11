package com.nexuscommerce.testsupport;

import com.nexuscommerce.payment.PaymentGateway;
import com.nexuscommerce.payment.PaymentInitiation;
import com.nexuscommerce.payment.PaymentRequest;
import com.nexuscommerce.payment.PaymentStatus;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Test double that records gateway interactions and lets tests script the
 * cancel outcome (e.g. "payment is mid-flight, refuse the cancel"). Behaves
 * like the manual gateway otherwise. Register with {@code @Primary} via a
 * {@code @TestConfiguration} in the test that needs it.
 */
public class RecordingPaymentGateway implements PaymentGateway {

    public record RefundCall(String paymentReference, BigDecimal amount, String currency) {}

    public final List<RefundCall> refunds = new CopyOnWriteArrayList<>();
    public final List<String> cancelledReferences = new CopyOnWriteArrayList<>();

    /** Scripted result for {@link #cancelPayment}; defaults to success. */
    public volatile boolean cancellable = true;

    /** Scripted expiry support; the real Stripe gateway returns true. */
    public volatile boolean supportsExpiry = true;

    @Override
    public PaymentInitiation initiate(PaymentRequest request) {
        return new PaymentInitiation(PaymentStatus.PENDING, "TEST-" + UUID.randomUUID(), "test-client-secret");
    }

    @Override
    public String refund(String paymentReference, BigDecimal amount, String currency) {
        refunds.add(new RefundCall(paymentReference, amount, currency));
        return "TEST-REFUND-" + UUID.randomUUID();
    }

    @Override
    public boolean cancelPayment(String paymentReference) {
        if (!cancellable) {
            return false;
        }
        cancelledReferences.add(paymentReference);
        return true;
    }

    @Override
    public Optional<String> findClientSecret(String paymentReference) {
        return Optional.of("test-client-secret");
    }

    @Override
    public boolean supportsAutomaticExpiry() {
        return supportsExpiry;
    }
}
