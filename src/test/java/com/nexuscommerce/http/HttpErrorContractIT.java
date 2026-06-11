package com.nexuscommerce.http;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nexuscommerce.testsupport.EmbeddedPostgresConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The HTTP error contract over the full filter chain: denied requests must be
 * 401/403 in the ApiResponse envelope — never the empty 403 Spring defaults to,
 * and never the 500 the catch-all used to turn role denials into.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Import(EmbeddedPostgresConfig.class)
class HttpErrorContractIT {

    @Autowired private TestRestTemplate rest;
    @Autowired private ObjectMapper objectMapper;

    @Test
    void missingTokenIsA401InTheApiEnvelope() {
        ResponseEntity<String> response = rest.getForEntity("/api/cart", String.class);

        assertThat(response.getStatusCode().value()).isEqualTo(401);
        assertThat(response.getBody()).contains("\"success\":false");
    }

    @Test
    void garbageTokenIsA401NotA500() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth("not-a-jwt");
        ResponseEntity<String> response = rest.exchange(
                "/api/cart", HttpMethod.GET, new HttpEntity<>(headers), String.class);

        assertThat(response.getStatusCode().value()).isEqualTo(401);
    }

    @Test
    void wrongRoleIsA403InTheApiEnvelope() {
        String customerToken = registerCustomer();
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(customerToken);

        // Merchant-only endpoint, guarded by @PreAuthorize (method security).
        ResponseEntity<String> merchantOnly = rest.exchange(
                "/api/products/my", HttpMethod.GET, new HttpEntity<>(headers), String.class);
        assertThat(merchantOnly.getStatusCode().value()).isEqualTo(403);
        assertThat(merchantOnly.getBody()).contains("\"success\":false");

        // Admin-only endpoint.
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<String> adminOnly = rest.exchange(
                "/api/categories", HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "X", "slug", "x-" + UUID.randomUUID()), headers),
                String.class);
        assertThat(adminOnly.getStatusCode().value()).isEqualTo(403);
    }

    @Test
    void healthProbeIsPublic() {
        ResponseEntity<String> response = rest.getForEntity("/actuator/health", String.class);

        assertThat(response.getStatusCode().value()).isEqualTo(200);
    }

    private String registerCustomer() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        Map<String, String> body = Map.of(
                "email", "http-" + UUID.randomUUID() + "@test.local",
                "password", "password123",
                "fullName", "Http Test",
                "phoneNumber", "+1" + (1_000_000_000L + ThreadLocalRandom.current().nextLong(8_999_999_999L)));
        ResponseEntity<String> response = rest.postForEntity(
                "/api/auth/register", new HttpEntity<>(body, headers), String.class);
        assertThat(response.getStatusCode().value()).isEqualTo(201);
        try {
            JsonNode root = objectMapper.readTree(response.getBody());
            return root.path("data").path("accessToken").asText();
        } catch (Exception e) {
            throw new IllegalStateException("Unable to parse register response", e);
        }
    }
}
