package com.nexuscommerce.auth.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.nexuscommerce.common.dto.ApiResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;

import java.io.IOException;

/**
 * Renders unauthenticated access to a protected endpoint as a 401 with the
 * standard {@link ApiResponse} envelope. Without this, Spring Security's default
 * commits an empty 403 — the wrong status, in a shape no client of this API
 * expects. (Exceptions thrown in the JWT filter never reach
 * {@code @RestControllerAdvice}; this entry point is the filter-chain
 * equivalent.)
 */
@Component
@RequiredArgsConstructor
public class RestAuthenticationEntryPoint implements AuthenticationEntryPoint {

    private final ObjectMapper objectMapper;

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response,
                         AuthenticationException authException) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(response.getOutputStream(),
                ApiResponse.error("Authentication required"));
    }
}
