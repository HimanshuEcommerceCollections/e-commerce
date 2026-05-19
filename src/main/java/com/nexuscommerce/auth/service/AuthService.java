package com.nexuscommerce.auth.service;

import com.nexuscommerce.auth.dto.AuthResponse;
import com.nexuscommerce.auth.dto.LoginRequest;
import com.nexuscommerce.auth.dto.RegisterRequest;
import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.auth.entity.UserRole;
import com.nexuscommerce.auth.exception.EmailAlreadyRegisteredException;
import com.nexuscommerce.auth.repository.UserRepository;
import com.nexuscommerce.auth.security.CustomerUserDetails;
import lombok.RequiredArgsConstructor;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Objects;

@Service
@RequiredArgsConstructor
public class AuthService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final AuthenticationManager authenticationManager;

    /**
     * Registers a new user, hashes the password with BCrypt,
     * and immediately returns an access token so the client
     * does not need a separate login call.
     */
    @Transactional
    public AuthResponse register(RegisterRequest request) {
        if (userRepository.existsByEmail(request.email())) {
            throw new EmailAlreadyRegisteredException(request.email());
        }

        UserRole role = request.role() != null ? request.role() : UserRole.ROLE_CUSTOMER;

        User user = User.builder()
                .email(request.email())
                .password(passwordEncoder.encode(request.password()))
                .firstName(request.firstName())
                .lastName(request.lastName())
                .displayName(request.displayName())
                .role(role)
                .build();

        User savedUser = userRepository.save(Objects.requireNonNull(user));

        String token = jwtService.generateToken(new CustomerUserDetails(savedUser));
        return AuthResponse.of(token, jwtService.getExpirationMs(), savedUser);
    }

    /**
     * Authenticates credentials via Spring Security's AuthenticationManager
     * (which respects account-locked / disabled flags), then issues a JWT.
     */
    @Transactional
    public AuthResponse login(LoginRequest request) {
        // Throws BadCredentialsException / DisabledException / LockedException on failure
        authenticationManager.authenticate(
                new UsernamePasswordAuthenticationToken(request.email(), request.password())
        );

        User user = userRepository.findByEmail(request.email())
                .orElseThrow(() -> new IllegalStateException("Authenticated user disappeared"));

        userRepository.updateLastLoginAt(user.getId(), Instant.now());

        String token = jwtService.generateToken(new CustomerUserDetails(user));
        return AuthResponse.of(token, jwtService.getExpirationMs(), user);
    }
}
