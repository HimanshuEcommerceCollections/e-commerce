package com.nexuscommerce.auth.entity;

import com.nexuscommerce.common.entity.BaseEntity;
import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;

@Entity
@Table(
    name = "users",
    uniqueConstraints = {
        @UniqueConstraint(columnNames = "email", name = "uk_users_email"),
        @UniqueConstraint(columnNames = "phone_number", name = "uk_users_phone")
    }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class User extends BaseEntity {

    @Column(nullable = false, unique = true, length = 255)
    private String email;

    @Column(nullable = false)
    private String password;

    @Column(nullable = false, length = 200)
    private String fullName;

    /** Optional for legacy accounts; unique when present. */
    @Column(length = 20)
    private String phoneNumber;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private UserRole role;

    @Column(nullable = false)
    @Builder.Default
    private boolean enabled = true;

    @Column(nullable = false)
    @Builder.Default
    private boolean accountNonLocked = true;

    private Instant lastLoginAt;
}
