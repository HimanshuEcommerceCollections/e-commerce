package com.nexuscommerce.common.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Enables {@code @Scheduled} jobs (currently the pending-order expiry job).
 * Kept as its own config class so tests can exclude scheduling cleanly.
 */
@Configuration
@EnableScheduling
public class SchedulingConfig {
}
