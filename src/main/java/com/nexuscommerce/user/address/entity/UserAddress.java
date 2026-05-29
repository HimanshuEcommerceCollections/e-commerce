package com.nexuscommerce.user.address.entity;

import com.nexuscommerce.common.entity.BaseEntity;
import jakarta.persistence.*;
import lombok.*;

import java.util.UUID;

// When a migration tool is introduced, add a partial unique index to enforce
// the single-default invariant at the DB level (JPA cannot express WHERE clauses):
//   CREATE UNIQUE INDEX uniq_user_addresses_default
//   ON user_addresses (user_id) WHERE is_default = true AND deleted = false;
// Until then, the service serializes per-user mutations via pg_advisory_xact_lock.
@Entity
@Table(
    name = "user_addresses",
    indexes = @Index(name = "idx_user_addresses_user_id", columnList = "user_id, deleted")
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class UserAddress extends BaseEntity {

    @Column(name = "user_id", nullable = false, updatable = false)
    private UUID userId;

    @Column(nullable = false, length = 50)
    private String label;

    @Column(nullable = false, length = 200)
    private String recipientName;

    @Column(length = 20)
    private String phone;

    @Column(nullable = false, length = 255)
    private String addressLine1;

    @Column(length = 255)
    private String addressLine2;

    @Column(nullable = false, length = 100)
    private String city;

    @Column(nullable = false, length = 100)
    private String state;

    @Column(nullable = false, length = 20)
    private String postalCode;

    @Column(nullable = false, length = 100)
    private String country;

    @Column(name = "is_default", nullable = false)
    @Builder.Default
    private boolean isDefault = false;
}
