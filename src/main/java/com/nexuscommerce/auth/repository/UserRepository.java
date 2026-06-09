package com.nexuscommerce.auth.repository;

import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.auth.entity.UserRole;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface UserRepository extends JpaRepository<User, UUID> {

    Optional<User> findByEmail(String email);

    boolean existsByEmail(String email);

    boolean existsByPhoneNumber(String phoneNumber);

    List<User> findAllByRole(UserRole role);

    /** Stamp last-login without a full entity round-trip */
    @Modifying
    @Query("UPDATE User u SET u.lastLoginAt = :ts WHERE u.id = :id")
    void updateLastLoginAt(@Param("id") UUID id, @Param("ts") Instant ts);
}
