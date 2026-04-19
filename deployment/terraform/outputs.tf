# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

output "dsql_cluster_identifier" {
  description = "DSQL cluster identifier — used to construct the endpoint."
  value       = aws_dsql_cluster.main.identifier
}

output "dsql_endpoint" {
  description = "DSQL endpoint hostname, DSQL_ENDPOINT env var for the Lambda."
  value       = local.dsql_endpoint
}

output "lambda_function_name" {
  description = "Lambda function name — used by CI for update-function-code."
  value       = aws_lambda_function.api.function_name
}

output "static_bucket" {
  description = "S3 bucket holding the Vite client build — used by CI for sync."
  value       = aws_s3_bucket.static.bucket
}

output "region_artifacts_bucket" {
  description = "S3 bucket for per-region topojson artifacts."
  value       = aws_s3_bucket.region_artifacts.bucket
}

output "thumbnails_bucket" {
  description = "S3 bucket for project thumbnails — THUMBNAILS_BUCKET for the Lambda and manage-prod."
  value       = aws_s3_bucket.thumbnails.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id — used by CI for cache invalidation."
  value       = aws_cloudfront_distribution.main.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name — point DNS here."
  value       = aws_cloudfront_distribution.main.domain_name
}

output "lambda_function_url" {
  description = "Lambda Function URL — the CloudFront api origin and a useful direct target for debugging."
  value       = aws_lambda_function_url.api.function_url
}

output "rum_app_monitor_id" {
  description = "CloudWatch RUM app monitor id — VITE_RUM_APP_MONITOR_ID for the client build."
  value       = aws_rum_app_monitor.main.app_monitor_id
}

output "rum_identity_pool_id" {
  description = "Cognito identity pool id backing RUM guest auth — VITE_RUM_IDENTITY_POOL_ID."
  value       = aws_cognito_identity_pool.rum.id
}

output "rum_guest_role_arn" {
  description = "IAM role assumed by unauthenticated RUM clients — VITE_RUM_GUEST_ROLE_ARN."
  value       = aws_iam_role.rum_guest.arn
}
