package com.nexuscommerce.product.mapper;

import com.nexuscommerce.product.dto.CategoryResponse;
import com.nexuscommerce.product.entity.ProductCategory;
import org.mapstruct.Mapper;

@Mapper(componentModel = "spring")
public interface CategoryMapper {

    CategoryResponse toResponse(ProductCategory category);
}
