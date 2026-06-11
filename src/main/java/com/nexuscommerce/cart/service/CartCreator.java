package com.nexuscommerce.cart.service;

import com.nexuscommerce.cart.entity.Cart;
import com.nexuscommerce.cart.repository.CartRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * Creates a user's cart in its own transaction. Separate bean so the
 * REQUIRES_NEW proxy applies: when two requests race to create the same user's
 * cart, the loser's insert violates {@code uniq_carts_user_live} (V8) and only
 * this small transaction rolls back — the caller's transaction survives and
 * re-fetches the winner's cart.
 */
@Service
@RequiredArgsConstructor
public class CartCreator {

    private final CartRepository cartRepository;

    /**
     * @return the newly created cart, or {@code null} if a concurrent request
     *         created it first (caller re-fetches)
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Cart create(UUID userId) {
        try {
            return cartRepository.saveAndFlush(Cart.builder().userId(userId).build());
        } catch (DataIntegrityViolationException e) {
            return null;
        }
    }
}
