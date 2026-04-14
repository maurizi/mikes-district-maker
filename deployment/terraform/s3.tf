# S3 bucket serving the Vite client build through CloudFront.
resource "aws_s3_bucket" "static" {
  bucket        = "${var.project}-${var.environment}-static"
  force_destroy = !var.enable_production_safeguards
}

resource "aws_s3_bucket_public_access_block" "static" {
  bucket                  = aws_s3_bucket.static.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "static" {
  bucket = aws_s3_bucket.static.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# CloudFront OAC authorizes only the distribution to read from the bucket.
resource "aws_cloudfront_origin_access_control" "static" {
  name                              = "${var.project}-${var.environment}-static"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "static_bucket" {
  statement {
    sid       = "AllowCloudFrontOAC"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.static.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "static" {
  bucket = aws_s3_bucket.static.id
  policy = data.aws_iam_policy_document.static_bucket.json
}

# S3 bucket holding per-region TopoJSON and lookup artifacts. The server reads
# these on demand and caches to /tmp. Populated locally via `manage` commands.
resource "aws_s3_bucket" "region_artifacts" {
  bucket        = "${var.project}-${var.environment}-region-artifacts"
  force_destroy = !var.enable_production_safeguards
}

resource "aws_s3_bucket_public_access_block" "region_artifacts" {
  bucket                  = aws_s3_bucket.region_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

