package com.nexuscommerce.payment.webhook;

import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Persistence for {@link ProcessedWebhookEvent}, keyed by the provider's event id.
 */
public interface ProcessedWebhookEventRepository extends JpaRepository<ProcessedWebhookEvent, String> {
}
