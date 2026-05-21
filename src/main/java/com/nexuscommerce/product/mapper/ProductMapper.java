package com.nexuscommerce.product.mapper;

import com.nexuscommerce.product.dto.ProductDetailResponse;
import com.nexuscommerce.product.dto.ProductSummaryResponse;
import com.nexuscommerce.product.entity.Product;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;

import java.util.List;

@Mapper(componentModel = "spring", uses = {CategoryMapper.class})
public interface ProductMapper {

    @Mapping(source = "category.name", target = "categoryName")
    @Mapping(source = "imageUrls", target = "primaryImageUrl", qualifiedByName = "firstImage")
    ProductSummaryResponse toSummaryResponse(Product product);

    ProductDetailResponse toDetailResponse(Product product);

    @Named("firstImage")
    default String firstImage(List<String> imageUrls) {
        return imageUrls == null || imageUrls.isEmpty() ? null : imageUrls.get(0);
    }
}
