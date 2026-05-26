package com.nexuscommerce.cart.repository;

import com.nexuscommerce.cart.entity.CartItem;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface CartItemRepository extends JpaRepository<CartItem, UUID> {

    List<CartItem> findByCartIdAndDeletedFalse(UUID cartId);

    Optional<CartItem> findByCartIdAndProductIdAndDeletedFalse(UUID cartId, UUID productId);
}
