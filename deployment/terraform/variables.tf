# SPDX-License-Identifier: AGPL-3.0-or-later
# Modifications © 2026 Michael Maurizi Jr.

variable "project" {
  description = "Project name used in resource tags and naming."
  type        = string
  default     = "districtbuilder"
}

variable "environment" {
  description = "Environment name, e.g. dev / staging / production."
  type        = string
}

variable "aws_region" {
  description = "AWS region for all stack resources except the CloudFront ACM cert."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Apex or subdomain the app is served from, e.g. app.example.com. Must be in a Route53 hosted zone you own."
  type        = string
}

variable "route53_zone_name" {
  description = "Route53 hosted zone that owns domain_name (e.g. example.com). Leave blank to skip DNS + CloudFront DNS validation."
  type        = string
  default     = ""
}

variable "lambda_memory_mb" {
  description = "Lambda memory allocation. Raise if NestJS cold start is tight."
  type        = number
  default     = 1024
}

variable "lambda_timeout_seconds" {
  description = "Lambda invocation timeout. Must fit the ALB idle timeout."
  type        = number
  default     = 60
}

variable "lambda_reserved_concurrency" {
  description = "Concurrency cap for the API lambda. Bounds DSQL connection fan-out; raise for production."
  type        = number
  default     = 20
}

variable "lambda_architecture" {
  description = "Lambda CPU architecture. arm64 is ~20 percent cheaper for Node workloads."
  type        = string
  default     = "arm64"
  validation {
    condition     = contains(["arm64", "x86_64"], var.lambda_architecture)
    error_message = "lambda_architecture must be arm64 or x86_64."
  }
}

variable "lwa_layer_arn" {
  description = "Lambda Web Adapter layer ARN for the selected region+architecture. See https://github.com/awslabs/aws-lambda-web-adapter for the current version."
  type        = string
}

variable "region_artifacts_bucket" {
  description = "Existing S3 bucket holding per-region static artifacts (TopoJSON, hierarchy, demographic typed arrays) and the basemap PMTiles. Fronted by CloudFront and read by the API Lambda."
  type        = string
  default     = "districtbuilder-dev-238046523378"
}

variable "cloudfront_price_class" {
  description = "CloudFront price class. PriceClass_100 covers NA + EU and is cheapest."
  type        = string
  default     = "PriceClass_100"
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the Lambda and ALB logs."
  type        = number
  default     = 14
}

variable "alarm_email" {
  description = "Email address subscribed to the API error SNS topic. Leave blank to skip subscription."
  type        = string
  default     = ""
}

variable "jwt_secret" {
  description = "Secret used to sign auth JWTs. Generate with `openssl rand -hex 32`."
  type        = string
  sensitive   = true
}

variable "jwt_expiration_ms" {
  description = "JWT expiry in milliseconds."
  type        = number
  default     = 604800000 # 1 week
}

variable "default_from_email" {
  description = "Sender address for transactional email. Must be verified in SES while the account is in sandbox."
  type        = string
}

variable "plan_score_api_token" {
  description = "Bearer token for PlanScore API. Leave blank to disable PlanScore integration."
  type        = string
  sensitive   = true
  default     = ""
}

variable "enable_production_safeguards" {
  description = "When true, enables DSQL deletion protection and disables S3 force_destroy. Keep false during initial bring-up; flip to true after verification."
  type        = bool
  default     = true
}
