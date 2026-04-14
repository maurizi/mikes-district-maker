resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${var.project}-${var.environment}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/cloudfront-functions/spa-rewrite.js")
}

# CloudFront ACM cert must be in us-east-1.
resource "aws_acm_certificate" "cloudfront" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  price_class         = var.cloudfront_price_class
  aliases             = [var.domain_name]
  comment             = "${var.project} ${var.environment}"
  default_root_object = "index.html"

  # Static assets from S3 (default origin — everything not matched below).
  origin {
    origin_id                = "s3-static"
    domain_name              = aws_s3_bucket.static.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.static.id
  }

  # API traffic → Lambda Function URL.
  origin {
    origin_id   = "lambda-url-api"
    domain_name = local.lambda_url_host
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "X-CloudFront-Origin"
      value = "api"
    }
  }

  # Default: S3 static assets. Long-cache the fingerprinted Vite output.
  default_cache_behavior {
    target_origin_id       = "s3-static"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true
    # Managed cache policy "CachingOptimized" — long TTL with compression.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    # Rewrite SPA routes (e.g. /projects/abc) to /index.html so page refresh
    # and back/forward land on the app shell instead of a 403 from S3.
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  # /api/* → Lambda Function URL, no caching, forward everything except Host.
  # Lambda Function URLs require the Host header to match their own hostname,
  # so we use the managed "AllViewerExceptHostHeader" origin request policy.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "lambda-url-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # Managed cache policy "CachingDisabled".
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    # Managed origin request policy "AllViewerExceptHostHeader".
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  # /healthcheck → Lambda Function URL, same policy as /api/*.
  ordered_cache_behavior {
    path_pattern           = "/healthcheck"
    target_origin_id       = "lambda-url-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    # AllViewerExceptHostHeader — required for Lambda Function URLs.
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.cloudfront.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
