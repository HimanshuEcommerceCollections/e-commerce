package com.nexuscommerce.payment.webhook;

import com.nexuscommerce.common.dto.ApiResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public endpoint that receives Stripe webhook callbacks. Registered only when
 * {@code app.payment.provider=stripe}.
 *
 * <p>The path is whitelisted in {@code SecurityConfig} (no JWT — Stripe does not
 * send one); authenticity is established by the {@code Stripe-Signature} header,
 * which {@link StripeWebhookService} verifies. The body is taken as the raw
 * string because signature verification must run over the exact bytes received.
 *
 * <p>Returns 200 once accepted/processed. A bad signature surfaces as 400 (via
 * {@code WebhookVerificationException}) so Stripe stops retrying it.
 */
@RestController
@RequestMapping("/api/payments/stripe")
@RequiredArgsConstructor
@ConditionalOnProperty(name = "app.payment.provider", havingValue = "stripe")
public class StripeWebhookController {

    private final StripeWebhookService webhookService;

    @PostMapping("/webhook")
    public ResponseEntity<ApiResponse<Void>> handle(
            @RequestBody String payload,
            @RequestHeader("Stripe-Signature") String signature) {
        webhookService.process(payload, signature);
        return ResponseEntity.ok(ApiResponse.noContent("Webhook processed"));
    }
}
