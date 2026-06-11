package com.nexuscommerce.cart;

import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.cart.exception.CartItemNotFoundException;
import com.nexuscommerce.cart.repository.CartRepository;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.testsupport.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The V8 invariants and the CartService fixes that depend on them. */
class CartIntegrityIT extends IntegrationTest {

    @Autowired private CartRepository cartRepository;
    @Autowired private JdbcTemplate jdbc;

    @Test
    void gettingTheCartActuallyPersistsIt() {
        User user = newCustomer();

        cartService.getCart(user.getId());

        // Regression: creation used to happen inside a read-only transaction and
        // the new cart row was never flushed.
        assertThat(cartRepository.findByUserIdAndDeletedFalse(user.getId())).isPresent();
    }

    @Test
    void removeThenReaddReusesTheRowInsteadOfAccumulating() {
        User user = newCustomer();
        Product product = newActiveProduct(10, "5.00");

        addToCart(user.getId(), product.getId(), 2);
        cartService.removeItem(user.getId(), product.getId());
        addToCart(user.getId(), product.getId(), 3);
        cartService.removeItem(user.getId(), product.getId());
        addToCart(user.getId(), product.getId(), 1);

        UUID cartId = cartRepository.findByUserIdAndDeletedFalse(user.getId()).orElseThrow().getId();
        Integer totalRows = jdbc.queryForObject(
                "SELECT count(*) FROM cart_items WHERE cart_id = ? AND product_id = ?",
                Integer.class, cartId, product.getId());
        assertThat(totalRows).isEqualTo(1);
        assertThat(cartService.getCart(user.getId()).items()).singleElement()
                .satisfies(item -> assertThat(item.quantity()).isEqualTo(1));
    }

    @Test
    void clearingWithoutACartDoesNotCreateOne() {
        User user = newCustomer();

        cartService.clearCart(user.getId());

        assertThat(cartRepository.findByUserIdAndDeletedFalse(user.getId())).isEmpty();
    }

    @Test
    void removingFromANonexistentCartIsA404NotASideEffect() {
        User user = newCustomer();

        assertThatThrownBy(() -> cartService.removeItem(user.getId(), UUID.randomUUID()))
                .isInstanceOf(CartItemNotFoundException.class);
        assertThat(cartRepository.findByUserIdAndDeletedFalse(user.getId())).isEmpty();
    }

    @Test
    void theDatabaseRejectsADuplicateLiveCartPerUser() {
        User user = newCustomer();
        cartService.getCart(user.getId()); // creates the live cart

        // The V8 partial unique index, not application code, is the last line of
        // defence against the historical duplicate-cart race.
        assertThatThrownBy(() -> jdbc.update(
                "INSERT INTO carts (id, created_at, updated_at, deleted, user_id) " +
                        "VALUES (?, now(), now(), false, ?)",
                UUID.randomUUID(), user.getId()))
                .hasMessageContaining("uniq_carts_user_live");
    }

    @Test
    void theDatabaseRejectsDuplicateLiveLinesPerProduct() {
        User user = newCustomer();
        Product product = newActiveProduct(10, "5.00");
        addToCart(user.getId(), product.getId(), 1);
        UUID cartId = cartRepository.findByUserIdAndDeletedFalse(user.getId()).orElseThrow().getId();

        assertThatThrownBy(() -> jdbc.update(
                "INSERT INTO cart_items (id, created_at, updated_at, deleted, cart_id, product_id, quantity) " +
                        "VALUES (?, now(), now(), false, ?, ?, 1)",
                UUID.randomUUID(), cartId, product.getId()))
                .hasMessageContaining("uniq_cart_items_cart_product_live");
    }
}
