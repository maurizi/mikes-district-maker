# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

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

# Project thumbnails uploaded by the client on save via presigned S3 PUT
# URLs, served back to the home-page mini-map and OG:image tag.
#
# These are inherently public content (Twitter/Bluesky og:image crawlers
# fetch them anonymously), so the bucket is public-read — no CloudFront OAC,
# no IAM dance. Dev can hit the bucket URL directly without touching prod
# CloudFront. UUID object keys make dev/prod bucket sharing safe.
resource "aws_s3_bucket" "thumbnails" {
  bucket        = "${var.project}-${var.environment}-thumbnails"
  force_destroy = !var.enable_production_safeguards
}

resource "aws_s3_bucket_public_access_block" "thumbnails" {
  bucket             = aws_s3_bucket.thumbnails.id
  block_public_acls  = true
  ignore_public_acls = true
  # Allow the public-read bucket policy below.
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_ownership_controls" "thumbnails" {
  bucket = aws_s3_bucket.thumbnails.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# CORS for browser-side PUTs via the presigned URL minted by the API.
resource "aws_s3_bucket_cors_configuration" "thumbnails" {
  bucket = aws_s3_bucket.thumbnails.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = [
      "https://${var.domain_name}",
      "http://localhost:3003",
      "https://localhost:3003"
    ]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "thumbnails_bucket" {
  statement {
    sid       = "AllowPublicRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.thumbnails.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "thumbnails" {
  bucket     = aws_s3_bucket.thumbnails.id
  policy     = data.aws_iam_policy_document.thumbnails_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.thumbnails]
}


