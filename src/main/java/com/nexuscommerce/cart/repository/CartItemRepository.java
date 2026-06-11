package com.nexuscommerce.cart.repository;

import com.nexuscommerce.cart.entity.CartItem;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface CartItemRepository extends JpaRepository<CartItem, UUID> {

    List<CartItem> findByCartIdAndDeletedFalse(UUID cartId);

    Optional<CartItem> findByCartIdAndProductIdAndDeletedFalse(UUID cartId, UUID productId);

    /**
     * Most recently removed line for this product, if any. Re-adding a product
     * un-deletes this row instead of inserting a fresh one — remove/re-add cycles
     * no longer accumulate rows, and the live-row unique index stays satisfiable.
     * (Soft-deleted duplicates may pre-date V8's dedupe, hence "most recent".)
     */
    Optional<CartItem> findFirstByCartIdAndProductIdAndDeletedTrueOrderByUpdatedAtDesc(UUID cartId, UUID productId);
}
