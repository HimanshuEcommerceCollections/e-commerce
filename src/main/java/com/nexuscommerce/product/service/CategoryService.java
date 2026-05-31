package com.nexuscommerce.product.service;

import com.nexuscommerce.product.dto.CategoryCreateRequest;
import com.nexuscommerce.product.dto.CategoryResponse;
import com.nexuscommerce.product.entity.ProductCategory;
import com.nexuscommerce.product.exception.CategoryNotFoundException;
import com.nexuscommerce.product.exception.SlugAlreadyExistsException;
import com.nexuscommerce.product.mapper.CategoryMapper;
import com.nexuscommerce.product.repository.ProductCategoryRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Transactional
public class CategoryService {

    private final ProductCategoryRepository categoryRepository;
    private final CategoryMapper categoryMapper;

    public CategoryResponse create(CategoryCreateRequest request) {
        if (categoryRepository.existsBySlug(request.slug())) {
            throw new SlugAlreadyExistsException(request.slug());
        }

        ProductCategory category = ProductCategory.builder()
                .name(request.name())
                .slug(request.slug())
                .description(request.description())
                .build();
        return categoryMapper.toResponse(categoryRepository.save(category));
    }

    @Transactional(readOnly = true)
    public List<CategoryResponse> findAll() {
        return categoryRepository.findAll().stream()
                .filter(c -> !c.isDeleted())
                .map(categoryMapper::toResponse)
                .toList();
    }

    @Transactional(readOnly = true)
    public CategoryResponse findById(UUID id) {
        return categoryRepository.findById(id)
                .filter(c -> !c.isDeleted())
                .map(categoryMapper::toResponse)
                .orElseThrow(() -> new CategoryNotFoundException(id));
    }
}
