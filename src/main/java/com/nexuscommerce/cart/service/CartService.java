package com.nexuscommerce.cart.service;

import com.nexuscommerce.cart.dto.CartItemRequest;
import com.nexuscommerce.cart.dto.CartItemResponse;
import com.nexuscommerce.cart.dto.CartItemUpdateRequest;
import com.nexuscommerce.cart.dto.CartResponse;
import com.nexuscommerce.cart.entity.Cart;
import com.nexuscommerce.cart.entity.CartItem;
import com.nexuscommerce.cart.exception.CartItemNotFoundException;
import com.nexuscommerce.cart.exception.InsufficientStockException;
import com.nexuscommerce.cart.exception.ProductNotAvailableException;
import com.nexuscommerce.cart.repository.CartItemRepository;
import com.nexuscommerce.cart.repository.CartRepository;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.product.entity.ProductStatus;
import com.nexuscommerce.product.repository.ProductRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Transactional
public class CartService {

    private final CartRepository cartRepository;
    private final CartItemRepository cartItemRepository;
    private final CartCreator cartCreator;
    private final ProductRepository productRepository;

    /**
     * Fetch (lazily creating) the caller's cart. Not read-only: the first GET
     * creates the cart row, and a write inside a read-only transaction is never
     * flushed — the previous version of this method "created" carts that didn't
     * survive the request.
     */
    public CartResponse getCart(UUID userId) {
        Cart cart = getOrCreateCart(userId);
        return buildCartResponse(cart);
    }

    public CartResponse addItem(UUID userId, CartItemRequest request) {
        Product product = validateProduct(request.productId());
        Cart cart = getOrCreateCart(userId);

        cartItemRepository.findByCartIdAndProductIdAndDeletedFalse(cart.getId(), request.productId())
                .ifPresentOrElse(existing -> {
                    int newQty = existing.getQuantity() + request.quantity();
                    validateStock(product, newQty);
                    existing.setQuantity(newQty);
                }, () -> {
                    validateStock(product, request.quantity());
                    addNewLine(cart, request);
                });

        return buildCartResponse(cart);
    }

    public CartResponse updateItem(UUID userId, UUID productId, CartItemUpdateRequest request) {
        Product product = validateProduct(productId);
        Cart cart = requireCart(userId, productId);

        CartItem item = cartItemRepository.findByCartIdAndProductIdAndDeletedFalse(cart.getId(), productId)
                .orElseThrow(() -> new CartItemNotFoundException(productId));

        validateStock(product, request.quantity());
        item.setQuantity(request.quantity());

        return buildCartResponse(cart);
    }

    public void removeItem(UUID userId, UUID productId) {
        Cart cart = requireCart(userId, productId);
        CartItem item = cartItemRepository.findByCartIdAndProductIdAndDeletedFalse(cart.getId(), productId)
                .orElseThrow(() -> new CartItemNotFoundException(productId));
        item.setDeleted(true);
    }

    public void clearCart(UUID userId) {
        // No cart → nothing to clear. Deliberately does not create one as a side
        // effect (the previous version inserted an empty cart row on DELETE).
        cartRepository.findByUserIdAndDeletedFalse(userId).ifPresent(cart ->
                cartItemRepository.findByCartIdAndDeletedFalse(cart.getId())
                        .forEach(item -> item.setDeleted(true)));
    }

    /**
     * Adding a previously-removed product un-deletes its most recent soft-deleted
     * row (with the fresh quantity) instead of inserting another one — repeated
     * remove/re-add no longer accumulates rows, and the V8 live-row unique index
     * stays satisfiable. A brand-new product inserts; if two requests race the
     * insert, the index rejects the loser with a 409 and the client's retry
     * merges normally.
     */
    private void addNewLine(Cart cart, CartItemRequest request) {
        cartItemRepository
                .findFirstByCartIdAndProductIdAndDeletedTrueOrderByUpdatedAtDesc(cart.getId(), request.productId())
                .ifPresentOrElse(removed -> {
                    removed.setDeleted(false);
                    removed.setQuantity(request.quantity());
                }, () -> cartItemRepository.save(CartItem.builder()
                        .cart(cart)
                        .productId(request.productId())
                        .quantity(request.quantity())
                        .build()));
    }

    /**
     * The V8 unique index makes concurrent creation safe: the loser of the race
     * gets {@code null} back from {@link CartCreator} (its own small transaction
     * rolled back) and re-fetches the winner's row.
     */
    private Cart getOrCreateCart(UUID userId) {
        return cartRepository.findByUserIdAndDeletedFalse(userId)
                .orElseGet(() -> {
                    Cart created = cartCreator.create(userId);
                    return created != null
                            ? created
                            : cartRepository.findByUserIdAndDeletedFalse(userId)
                                    .orElseThrow(() -> new IllegalStateException(
                                            "Cart creation race left no live cart for user " + userId));
                });
    }

    /**
     * Mutations of existing lines never create a cart as a side effect: a user
     * with no cart cannot have the line they are trying to change, so this is
     * the same 404 as a missing line.
     */
    private Cart requireCart(UUID userId, UUID productId) {
        return cartRepository.findByUserIdAndDeletedFalse(userId)
                .orElseThrow(() -> new CartItemNotFoundException(productId));
    }

    private Product validateProduct(UUID productId) {
        Product product = productRepository.findByIdAndDeletedFalse(productId)
                .orElseThrow(() -> new ProductNotAvailableException(productId));
        if (product.getStatus() != ProductStatus.ACTIVE) {
            throw new ProductNotAvailableException(productId);
        }
        return product;
    }

    private void validateStock(Product product, int requestedQty) {
        if (requestedQty > product.getStockQuantity()) {
            throw new InsufficientStockException(product.getStockQuantity(), requestedQty);
        }
    }

    private CartResponse buildCartResponse(Cart cart) {
        List<CartItem> items = cartItemRepository.findByCartIdAndDeletedFalse(cart.getId());

        // One batch product lookup for the whole cart (was one query per line).
        Map<UUID, Product> products = productRepository
                .findByIdInAndDeletedFalse(items.stream().map(CartItem::getProductId).toList())
                .stream()
                .collect(Collectors.toMap(Product::getId, Function.identity()));

        // Soft-deleted products are excluded (no data to display).
        // Products that exist but are not ACTIVE appear with available=false.
        List<CartItemResponse> itemResponses = items.stream()
                .map(item -> {
                    Product product = products.get(item.getProductId());
                    return product != null ? buildCartItemResponse(item, product) : null;
                })
                .filter(r -> r != null)
                .toList();

        // Only available items count toward totals
        BigDecimal totalPrice = itemResponses.stream()
                .filter(CartItemResponse::available)
                .map(CartItemResponse::subtotal)
                .reduce(BigDecimal.ZERO, BigDecimal::add);

        int totalItems = itemResponses.stream()
                .filter(CartItemResponse::available)
                .mapToInt(CartItemResponse::quantity)
                .sum();

        return new CartResponse(
                cart.getId(),
                cart.getUserId(),
                itemResponses,
                totalItems,
                totalPrice,
                cart.getUpdatedAt()
        );
    }

    private CartItemResponse buildCartItemResponse(CartItem item, Product product) {
        boolean available = product.getStatus() == ProductStatus.ACTIVE;
        String primaryImageUrl = product.getPrimaryImageUrl();
        BigDecimal subtotal = available
                ? product.getPrice().multiply(BigDecimal.valueOf(item.getQuantity()))
                : BigDecimal.ZERO;
        return new CartItemResponse(
                product.getId(),
                product.getName(),
                product.getSku(),
                primaryImageUrl,
                product.getPrice(),
                item.getQuantity(),
                subtotal,
                available
        );
    }
}
