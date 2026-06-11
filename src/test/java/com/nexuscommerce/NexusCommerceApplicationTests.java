package com.nexuscommerce;

import com.nexuscommerce.testsupport.IntegrationTest;
import org.junit.jupiter.api.Test;

/**
 * Context smoke test. Extends {@link IntegrationTest} so it boots against the
 * embedded Postgres — running it must never touch the configured live database.
 * Booting the context also runs every Flyway migration and Hibernate's
 * schema validation, so this test alone verifies migrations ↔ entity drift.
 */
class NexusCommerceApplicationTests extends IntegrationTest {

	@Test
	void contextLoads() {
	}

}
