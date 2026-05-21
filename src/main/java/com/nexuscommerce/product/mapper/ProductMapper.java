package com.nexuscommerce.product.mapper;

import com.nexuscommerce.product.dto.ProductDetailResponse;
import com.nexuscommerce.product.dto.ProductSummaryResponse;
import com.nexuscommerce.product.entity.Product;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper(componentModel = "spring", uses = {CategoryMapper.class})
public interface ProductMapper {

    @Mapping(target = "categoryName", expression = "java(product.getCategory() != null ? product.getCategory().getName() : null)")
    @Mapping(target = "primaryImageUrl", expression = "java(product.getImageUrls() != null && !product.getImageUrls().isEmpty() ? product.getImageUrls().get(0) : null)")
    ProductSummaryResponse toSummaryResponse(Product product);

    ProductDetailResponse toDetailResponse(Product product);
}
