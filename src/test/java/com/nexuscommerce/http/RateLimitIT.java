package com.nexuscommerce.http;

import com.nexuscommerce.testsupport.EmbeddedPostgresConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Auth endpoints throttle by client IP once the bucket is drained. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "app.rate-limit.enabled=true",
                "app.rate-limit.auth.capacity=3",
                "app.rate-limit.auth.refill-per-minute=1"
        })
@ActiveProfiles("test")
@Import(EmbeddedPostgresConfig.class)
class RateLimitIT {

    @Autowired private TestRestTemplate rest;

    @Test
    void loginAttemptsBeyondTheBucketAre429() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, String>> badLogin = new HttpEntity<>(
                Map.of("email", "nobody@test.local", "password", "wrong-password"), headers);

        for (int attempt = 1; attempt <= 3; attempt++) {
            ResponseEntity<String> response = rest.postForEntity("/api/auth/login", badLogin, String.class);
            assertThat(response.getStatusCode().value())
                    .as("attempt %d should pass the limiter", attempt)
                    .isEqualTo(401);
        }

        ResponseEntity<String> throttled = rest.postForEntity("/api/auth/login", badLogin, String.class);
        assertThat(throttled.getStatusCode().value()).isEqualTo(429);
        assertThat(throttled.getBody()).contains("\"success\":false");
    }
}
