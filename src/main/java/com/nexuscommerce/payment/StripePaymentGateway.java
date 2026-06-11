package com.nexuscommerce.payment;

import com.stripe.exception.StripeException;
import com.stripe.model.PaymentIntent;
import com.stripe.model.Refund;
import com.stripe.net.RequestOptions;
import com.stripe.param.PaymentIntentCreateParams;
import com.stripe.param.RefundCreateParams;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.Optional;
import java.util.Set;

/**
 * Real payment provider backed by Stripe. Active when
 * {@code app.payment.provider=stripe}; otherwise {@link ManualPaymentGateway} is
 * used. Creating this bean replaces the manual one, so checkout is unchanged —
 * it still depends only on {@link PaymentGateway}.
 *
 * <p>{@link #initiate(PaymentRequest)} creates a Stripe PaymentIntent and returns
 * its {@code clientSecret} for the browser/app to confirm. The order stays in
 * PENDING_PAYMENT until Stripe confirms the result out-of-band via the webhook
 * (see {@code StripeWebhookService}), which is why the status is {@code PENDING}
 * here — money has not moved yet.
 */
@Slf4j
@Service
@ConditionalOnProperty(name = "app.payment.provider", havingValue = "stripe")
public class StripePaymentGateway implements PaymentGateway {

    /** PaymentIntent statuses that mean "too late to cancel — money is moving or moved". */
    private static final Set<String> NOT_CANCELLABLE_STATUSES = Set.of(
            "succeeded", "processing", "requires_capture");

    private final String secretKey;
    private final int connectTimeoutMs;
    private final int readTimeoutMs;

    public StripePaymentGateway(
            @Value("${app.payment.stripe.secret-key}") String secretKey,
            @Value("${app.payment.stripe.connect-timeout-ms:10000}") int connectTimeoutMs,
            @Value("${app.payment.stripe.read-timeout-ms:20000}") int readTimeoutMs) {
        // Fail fast: booting "configured for Stripe" without a usable key would
        // surface as a 502 on the first checkout instead of at deploy time.
        if (secretKey == null || secretKey.isBlank() || secretKey.contains("REPLACE")) {
            throw new IllegalStateException(
                    "app.payment.provider=stripe requires STRIPE_SECRET_KEY to be set");
        }
        this.secretKey = secretKey;
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
    }

    @Override
    public PaymentInitiation initiate(PaymentRequest request) {
        PaymentIntentCreateParams params = PaymentIntentCreateParams.builder()
                .setAmount(MoneyUnits.toMinorUnits(request.amount(), request.currency()))
                .setCurrency(request.currency().toLowerCase())
                // Lets Stripe present whatever payment methods are enabled on the
                // account without the client having to enumerate them.
                .setAutomaticPaymentMethods(
                        PaymentIntentCreateParams.AutomaticPaymentMethods.builder()
                                .setEnabled(true)
                                .build())
                // Human-traceable backref from the Stripe dashboard to our order.
                .putMetadata("orderNumber", request.orderNumber())
                .build();

        // Idempotency key scoped to the order: a retried checkout for the same
        // order reuses the existing PaymentIntent rather than creating a duplicate.
        RequestOptions options = requestOptions("order-" + request.orderNumber());

        try {
            PaymentIntent intent = PaymentIntent.create(params, options);
            return new PaymentInitiation(PaymentStatus.PENDING, intent.getId(), intent.getClientSecret());
        } catch (StripeException e) {
            log.error("Stripe PaymentIntent creation failed for order {}", request.orderNumber(), e);
            throw new PaymentGatewayException("Unable to initiate payment", e);
        }
    }

    @Override
    public String refund(String paymentReference, BigDecimal amount, String currency) {
        RefundCreateParams params = RefundCreateParams.builder()
                .setPaymentIntent(paymentReference)
                .setAmount(MoneyUnits.toMinorUnits(amount, currency))
                .build();
        // Phase 1 issues at most one (full) refund per intent, so keying on the
        // intent makes a retried cancel reuse the same refund instead of
        // double-refunding.
        RequestOptions options = requestOptions("refund-" + paymentReference);

        try {
            Refund refundResult = Refund.create(params, options);
            return refundResult.getId();
        } catch (StripeException e) {
            log.error("Stripe refund failed for intent {}", paymentReference, e);
            throw new PaymentGatewayException("Unable to refund payment", e);
        }
    }

    @Override
    public boolean cancelPayment(String paymentReference) {
        try {
            PaymentIntent intent = PaymentIntent.retrieve(paymentReference, requestOptions(null));
            if ("canceled".equals(intent.getStatus())) {
                return true;
            }
            if (NOT_CANCELLABLE_STATUSES.contains(intent.getStatus())) {
                return false;
            }
            intent.cancel(requestOptions(null));
            return true;
        } catch (StripeException e) {
            // The cancel can race the customer completing payment; re-check before
            // treating it as a hard failure.
            String status = currentStatus(paymentReference);
            if (status != null && NOT_CANCELLABLE_STATUSES.contains(status)) {
                return false;
            }
            if ("canceled".equals(status)) {
                return true;
            }
            log.error("Stripe PaymentIntent cancel failed for intent {}", paymentReference, e);
            throw new PaymentGatewayException("Unable to cancel payment", e);
        }
    }

    @Override
    public Optional<String> findClientSecret(String paymentReference) {
        try {
            return Optional.ofNullable(
                    PaymentIntent.retrieve(paymentReference, requestOptions(null)).getClientSecret());
        } catch (StripeException e) {
            log.error("Stripe PaymentIntent retrieve failed for intent {}", paymentReference, e);
            throw new PaymentGatewayException("Unable to look up payment", e);
        }
    }

    @Override
    public boolean supportsAutomaticExpiry() {
        // Abandoned Stripe checkouts hold reserved stock forever unless expired.
        return true;
    }

    @Override
    public boolean supportsManualConfirmation() {
        // Stripe reports outcomes via webhook; hand-marking would diverge from money.
        return false;
    }

    private String currentStatus(String paymentReference) {
        try {
            return PaymentIntent.retrieve(paymentReference, requestOptions(null)).getStatus();
        } catch (StripeException e) {
            return null;
        }
    }

    private RequestOptions requestOptions(String idempotencyKey) {
        // Tight timeouts: checkout calls Stripe while holding product row locks
        // (the stock decrement), so the SDK's 80s default read timeout would let
        // one Stripe latency spike stall every checkout sharing a product.
        RequestOptions.RequestOptionsBuilder builder = RequestOptions.builder()
                .setApiKey(secretKey)
                .setConnectTimeout(connectTimeoutMs)
                .setReadTimeout(readTimeoutMs);
        if (idempotencyKey != null) {
            builder.setIdempotencyKey(idempotencyKey);
        }
        return builder.build();
    }
}
