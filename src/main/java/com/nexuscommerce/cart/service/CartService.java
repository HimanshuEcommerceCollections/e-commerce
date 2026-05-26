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
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Transactional
@SuppressWarnings("null")
public class CartService {

    private final CartRepository cartRepository;
    private final CartItemRepository cartItemRepository;
    private final ProductRepository productRepository;

    @Transactional(readOnly = true)
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
                    CartItem item = CartItem.builder()
                            .cart(cart)
                            .productId(request.productId())
                            .quantity(request.quantity())
                            .build();
                    cartItemRepository.save(item);
                });

        return buildCartResponse(cart);
    }

    public CartResponse updateItem(UUID userId, UUID productId, CartItemUpdateRequest request) {
        Product product = validateProduct(productId);
        Cart cart = getOrCreateCart(userId);

        CartItem item = cartItemRepository.findByCartIdAndProductIdAndDeletedFalse(cart.getId(), productId)
                .orElseThrow(() -> new CartItemNotFoundException(productId));

        validateStock(product, request.quantity());
        item.setQuantity(request.quantity());

        return buildCartResponse(cart);
    }

    public void removeItem(UUID userId, UUID productId) {
        Cart cart = getOrCreateCart(userId);
        CartItem item = cartItemRepository.findByCartIdAndProductIdAndDeletedFalse(cart.getId(), productId)
                .orElseThrow(() -> new CartItemNotFoundException(productId));
        item.setDeleted(true);
    }

    public void clearCart(UUID userId) {
        Cart cart = getOrCreateCart(userId);
        cartItemRepository.findByCartIdAndDeletedFalse(cart.getId())
                .forEach(item -> item.setDeleted(true));
    }

    private Cart getOrCreateCart(UUID userId) {
        return cartRepository.findByUserIdAndDeletedFalse(userId)
                .orElseGet(() -> cartRepository.save(Cart.builder().userId(userId).build()));
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

        // Soft-deleted products are excluded (no data to display).
        // Products that exist but are not ACTIVE appear with available=false.
        List<CartItemResponse> itemResponses = items.stream()
                .map(item -> productRepository.findByIdAndDeletedFalse(item.getProductId())
                        .map(product -> buildCartItemResponse(item, product))
                        .orElse(null))
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
        String primaryImageUrl = product.getImageUrls() != null && !product.getImageUrls().isEmpty()
                ? product.getImageUrls().get(0) : null;
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
