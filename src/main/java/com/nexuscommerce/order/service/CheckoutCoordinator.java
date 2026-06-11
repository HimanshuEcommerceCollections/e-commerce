package com.nexuscommerce.order.service;

import com.nexuscommerce.order.dto.CheckoutRequest;
import com.nexuscommerce.order.dto.CheckoutResponse;
import com.nexuscommerce.order.exception.EmptyCartException;
import com.nexuscommerce.order.exception.InvalidIdempotencyKeyException;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Wraps {@link OrderService#checkout} with Idempotency-Key semantics. Lives
 * outside OrderService (deliberately non-transactional) because the replay path
 * must run in a fresh transaction after the checkout transaction has rolled
 * back on a same-key race.
 *
 * <p>Flow for a keyed request:
 * <ol>
 *   <li>replay lookup — an order already created under (user, key) is returned
 *       as-is (422 if the key was reused with a different request);</li>
 *   <li>otherwise checkout runs normally with the key stamped on the order;</li>
 *   <li>if two same-key requests race, the V6 partial unique index fails the
 *       loser's commit — caught here and resolved by replaying the winner.</li>
 * </ol>
 *
 * <p>Without a key, checkout behaves exactly as before (no replay protection).
 */
@Service
@RequiredArgsConstructor
public class CheckoutCoordinator {

    private static final Pattern KEY_PATTERN = Pattern.compile("[A-Za-z0-9_-]{1,80}");

    private final OrderService orderService;

    public CheckoutResponse checkout(UUID userId, CheckoutRequest request, String rawIdempotencyKey) {
        String key = normalize(rawIdempotencyKey);
        if (key == null) {
            return orderService.checkout(userId, request, null, null);
        }

        // Hash of the client-controlled request body. The cart is server-side
        // state (and is consumed by the first successful checkout), so it is
        // intentionally not part of the hash.
        String hash = requestHash(userId, request);

        return orderService.replayCheckout(userId, key, hash)
                .orElseGet(() -> create(userId, request, key, hash));
    }

    private CheckoutResponse create(UUID userId, CheckoutRequest request, String key, String hash) {
        try {
            return orderService.checkout(userId, request, key, hash);
        } catch (DataIntegrityViolationException e) {
            // Same-key race: the other request committed first and its unique
            // index rejected ours (the whole losing transaction — including its
            // stock decrements — rolled back). Serve the winner's response.
            return orderService.replayCheckout(userId, key, hash).orElseThrow(() -> e);
        } catch (EmptyCartException e) {
            // The same race, lost slightly later: the keyed twin committed and
            // consumed the cart before this request read it. A genuinely empty
            // cart has no order under this key and rethrows.
            return orderService.replayCheckout(userId, key, hash).orElseThrow(() -> e);
        }
    }

    private String normalize(String rawKey) {
        if (rawKey == null || rawKey.isBlank()) {
            return null;
        }
        String key = rawKey.trim();
        if (!KEY_PATTERN.matcher(key).matches()) {
            throw new InvalidIdempotencyKeyException();
        }
        return key;
    }

    private String requestHash(UUID userId, CheckoutRequest request) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(
                    (userId + ":" + request.addressId()).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
