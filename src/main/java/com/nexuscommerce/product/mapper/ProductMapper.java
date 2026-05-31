package com.nexuscommerce.product.mapper;

import com.nexuscommerce.product.dto.ProductDetailResponse;
import com.nexuscommerce.product.dto.ProductImageResponse;
import com.nexuscommerce.product.dto.ProductSummaryResponse;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.product.entity.ProductImage;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper(componentModel = "spring", uses = {CategoryMapper.class})
public interface ProductMapper {

    @Mapping(target = "categoryName", expression = "java(product.getCategory() != null ? product.getCategory().getName() : null)")
    @Mapping(target = "primaryImageUrl", expression = "java(product.getPrimaryImageUrl())")
    ProductSummaryResponse toSummaryResponse(Product product);

    // 'images' (List<ProductImage>) maps to List<ProductImageResponse> via toImageResponse below.
    ProductDetailResponse toDetailResponse(Product product);

    ProductImageResponse toImageResponse(ProductImage image);
}
