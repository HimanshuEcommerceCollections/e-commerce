package com.nexuscommerce.testsupport;

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

import javax.sql.DataSource;
import java.io.IOException;
import java.io.UncheckedIOException;

/**
 * Points the datasource at an embedded real-Postgres instance (zonky — actual
 * PG binaries, no Docker required, which this dev machine doesn't have).
 *
 * <p>CRITICAL: without this override, tests would connect to whatever .env
 * configures — the LIVE database — and run Flyway migrations against it.
 * Every integration test must import this config (use {@link IntegrationTest}).
 *
 * <p>The instance is a static singleton shared across Spring test contexts:
 * Flyway migrates it once (V1→latest, validating the full migration chain) and
 * re-runs are no-ops. Tests must therefore use unique data (random emails/SKUs)
 * rather than assuming an empty database.
 */
@TestConfiguration(proxyBeanMethods = false)
public class EmbeddedPostgresConfig {

    private static volatile EmbeddedPostgres shared;

    @Bean
    @Primary
    public DataSource testDataSource() {
        return sharedInstance().getPostgresDatabase();
    }

    private static EmbeddedPostgres sharedInstance() {
        if (shared == null) {
            synchronized (EmbeddedPostgresConfig.class) {
                if (shared == null) {
                    try {
                        shared = EmbeddedPostgres.start();
                    } catch (IOException e) {
                        throw new UncheckedIOException("Unable to start embedded Postgres", e);
                    }
                }
            }
        }
        return shared;
    }
}
