package com.nexuscommerce.payment;

import com.stripe.exception.StripeException;
import com.stripe.model.PaymentIntent;
import com.stripe.net.RequestOptions;
import com.stripe.param.PaymentIntentCreateParams;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
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

    /**
     * ISO-4217 currencies that have no minor unit: their amounts are charged as
     * whole numbers, not multiplied by 100. (Stripe's "zero-decimal" set.)
     */
    private static final Set<String> ZERO_DECIMAL_CURRENCIES = Set.of(
            "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG",
            "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF");

    private final String secretKey;

    public StripePaymentGateway(@Value("${app.payment.stripe.secret-key}") String secretKey) {
        this.secretKey = secretKey;
    }

    @Override
    public PaymentInitiation initiate(PaymentRequest request) {
        PaymentIntentCreateParams params = PaymentIntentCreateParams.builder()
                .setAmount(toMinorUnits(request.amount(), request.currency()))
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
        RequestOptions options = RequestOptions.builder()
                .setApiKey(secretKey)
                .setIdempotencyKey("order-" + request.orderNumber())
                .build();

        try {
            PaymentIntent intent = PaymentIntent.create(params, options);
            return new PaymentInitiation(PaymentStatus.PENDING, intent.getId(), intent.getClientSecret());
        } catch (StripeException e) {
            log.error("Stripe PaymentIntent creation failed for order {}", request.orderNumber(), e);
            throw new PaymentGatewayException("Unable to initiate payment", e);
        }
    }

    /**
     * Convert a major-unit amount (e.g. dollars) to the integer minor units Stripe
     * expects (e.g. cents), honouring zero-decimal currencies. Uses exact
     * conversion so a fractional cent would surface as an error rather than be
     * silently rounded away.
     */
    private long toMinorUnits(BigDecimal amount, String currency) {
        BigDecimal scaled = ZERO_DECIMAL_CURRENCIES.contains(currency.toUpperCase())
                ? amount.setScale(0, RoundingMode.UNNECESSARY)
                : amount.movePointRight(2).setScale(0, RoundingMode.UNNECESSARY);
        return scaled.longValueExact();
    }
}
