package com.nexuscommerce.payment.webhook;

import com.nexuscommerce.common.dto.ApiResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin recovery tooling for stored webhook events. A FAILED event (handler bug,
 * amount mismatch under investigation, deserialization issue) keeps its verified
 * payload in {@code webhook_events}; once the cause is fixed, replaying
 * re-dispatches it from storage — no Stripe involvement needed.
 *
 * <p>Path is intentionally outside the public {@code /api/payments/stripe/webhook}
 * matcher, so it requires a normal authenticated ADMIN call.
 */
@RestController
@RequestMapping("/api/payments/stripe/webhook-events")
@RequiredArgsConstructor
@ConditionalOnProperty(name = "app.payment.provider", havingValue = "stripe")
public class WebhookAdminController {

    private final StripeWebhookService webhookService;

    @PostMapping("/{eventId}/replay")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<ApiResponse<Void>> replay(@PathVariable String eventId) {
        webhookService.replay(eventId);
        return ResponseEntity.ok(ApiResponse.noContent("Webhook event re-dispatched"));
    }
}
