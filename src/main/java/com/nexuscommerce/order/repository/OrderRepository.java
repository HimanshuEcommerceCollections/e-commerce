package com.nexuscommerce.order.repository;

import com.nexuscommerce.order.entity.Order;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface OrderRepository extends JpaRepository<Order, UUID> {

    /** Owner-scoped lookup — a customer may only read their own orders. */
    Optional<Order> findByIdAndUserIdAndDeletedFalse(UUID id, UUID userId);

    /** Unscoped lookup for admin/system operations (e.g. manual payment confirmation). */
    Optional<Order> findByIdAndDeletedFalse(UUID id);

    Page<Order> findByUserIdAndDeletedFalseOrderByCreatedAtDesc(UUID userId, Pageable pageable);

    boolean existsByOrderNumber(String orderNumber);
}
