package com.nexuscommerce.product.entity;

import com.nexuscommerce.common.entity.BaseEntity;
import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(
    name = "product_categories",
    uniqueConstraints = @UniqueConstraint(columnNames = "slug", name = "uk_product_categories_slug")
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ProductCategory extends BaseEntity {

    @Column(nullable = false, length = 100)
    private String name;

    @Column(nullable = false, unique = true, length = 120)
    private String slug;

    @Column(length = 500)
    private String description;
}
