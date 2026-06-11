package com.nexuscommerce.testsupport;

import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.auth.entity.UserRole;
import com.nexuscommerce.auth.repository.UserRepository;
import com.nexuscommerce.cart.dto.CartItemRequest;
import com.nexuscommerce.cart.service.CartService;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.product.entity.ProductStatus;
import com.nexuscommerce.product.repository.ProductRepository;
import com.nexuscommerce.user.address.entity.UserAddress;
import com.nexuscommerce.user.address.repository.UserAddressRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * Base class for integration tests: full Spring context against the embedded
 * Postgres (never the live database), manual payment gateway, test profile.
 *
 * <p>Provides fixture helpers; all generated data is unique per call (the
 * embedded database is shared across test contexts).
 */
@SpringBootTest
@ActiveProfiles("test")
@Import(EmbeddedPostgresConfig.class)
public abstract class IntegrationTest {

    @Autowired protected UserRepository userRepository;
    @Autowired protected ProductRepository productRepository;
    @Autowired protected UserAddressRepository addressRepository;
    @Autowired protected CartService cartService;

    protected User newCustomer() {
        return userRepository.save(User.builder()
                .email("customer-" + UUID.randomUUID() + "@test.local")
                .password("not-a-real-hash")
                .fullName("Test Customer")
                .role(UserRole.ROLE_CUSTOMER)
                .build());
    }

    protected Product newActiveProduct(int stock, String price) {
        return productRepository.save(Product.builder()
                .name("Test Product")
                .sku("SKU-" + UUID.randomUUID())
                .price(new BigDecimal(price))
                .stockQuantity(stock)
                .status(ProductStatus.ACTIVE)
                .merchantId(UUID.randomUUID())
                .build());
    }

    protected UserAddress newAddress(UUID userId) {
        return newAddress(userId, true);
    }

    /** Additional addresses must be non-default — uniq_user_addresses_default allows one default per user. */
    protected UserAddress newAddress(UUID userId, boolean isDefault) {
        return addressRepository.save(UserAddress.builder()
                .userId(userId)
                .label("Home")
                .recipientName("Test Customer")
                .phone("+1 555 000 1111")
                .addressLine1("1 Test Street")
                .city("Testville")
                .state("TS")
                .postalCode("12345")
                .country("US")
                .isDefault(isDefault)
                .build());
    }

    protected void addToCart(UUID userId, UUID productId, int quantity) {
        cartService.addItem(userId, new CartItemRequest(productId, quantity));
    }

    protected int stockOf(UUID productId) {
        return productRepository.findById(productId).orElseThrow().getStockQuantity();
    }
}
