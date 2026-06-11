package com.nexuscommerce.auth.filter;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.nexuscommerce.common.dto.ApiResponse;
import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Per-client-IP token-bucket throttle for the public auth endpoints — login and
 * register are otherwise unbounded brute-force/credential-stuffing targets
 * (users.account_non_locked exists but nothing locks accounts yet).
 *
 * <p>In-memory and per-instance by design (bucket4j core, no external store):
 * correct for the current single-instance deployment, and the bucket map is
 * LRU-bounded so hostile traffic cannot exhaust memory. Move the buckets to a
 * shared store when scaling out.
 */
@Component
@RequiredArgsConstructor
public class RateLimitFilter extends OncePerRequestFilter {

    private static final int MAX_TRACKED_CLIENTS = 10_000;

    private final ObjectMapper objectMapper;

    @Value("${app.rate-limit.enabled:true}")
    private boolean enabled;

    @Value("${app.rate-limit.auth.capacity:10}")
    private long capacity;

    @Value("${app.rate-limit.auth.refill-per-minute:10}")
    private long refillPerMinute;

    /** LRU-bounded, synchronized: access-order eviction of the oldest client. */
    private final Map<String, Bucket> buckets = Collections.synchronizedMap(
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Bucket> eldest) {
                    return size() > MAX_TRACKED_CLIENTS;
                }
            });

    @Override
    protected boolean shouldNotFilter(@NonNull HttpServletRequest request) {
        return !enabled || !request.getRequestURI().startsWith("/api/auth/");
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest request,
                                    @NonNull HttpServletResponse response,
                                    @NonNull FilterChain filterChain) throws ServletException, IOException {
        Bucket bucket = buckets.computeIfAbsent(clientKey(request), key -> newBucket());
        if (bucket.tryConsume(1)) {
            filterChain.doFilter(request, response);
            return;
        }
        response.setStatus(429);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(response.getOutputStream(),
                ApiResponse.error("Too many requests — try again shortly"));
    }

    /**
     * Remote address only. X-Forwarded-For is honoured by the container when
     * server.forward-headers-strategy is configured behind a trusted proxy —
     * never parsed here, where a client could spoof it to dodge the limit.
     */
    private String clientKey(HttpServletRequest request) {
        return request.getRemoteAddr();
    }

    private Bucket newBucket() {
        Bandwidth limit = Bandwidth.builder()
                .capacity(capacity)
                .refillGreedy(refillPerMinute, Duration.ofMinutes(1))
                .build();
        return Bucket.builder().addLimit(limit).build();
    }
}
