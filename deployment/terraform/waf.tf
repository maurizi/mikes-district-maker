# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# Edge rate-limiting for the API. The register/verify/reset endpoints send SES
# mail per request, so an unauthenticated flood against /api/auth/* burns the
# SES daily quota and trips the api-errors alarm (this happened 2026-07-20: one
# IP at ~35 req/min blew past the 51,200/day quota, after which every register
# 500'd on "Daily message quota exceeded"). App-level throttling can't fix it:
# the API is Lambda, so an in-memory counter resets per container and per-IP
# limits don't hold across concurrent invocations. WAF rate-based rules enforce
# per source IP at the edge, independent of Lambda concurrency, with no code.
#
# Two layers, evaluated in priority order:
#   1. /api/auth/* — tight, since these are unauthenticated and send email.
#   2. /api/*      — loose blanket safety net for any other unauthed endpoint;
#                    threshold sits well above a legit map/project session so it
#                    only catches a runaway flood, not heavy real usage.
# A request blocked by rule 1 never reaches rule 2, so auth paths get the tight
# limit and everything else under /api/ gets the loose one.
#
# WAF for CloudFront is a global (CLOUDFRONT-scope) resource and must be created
# in us-east-1 regardless of the stack's primary region.
resource "aws_wafv2_web_acl" "main" {
  provider    = aws.us_east_1
  name        = "${var.project}-${var.environment}-edge"
  # WAFv2 description rejects parentheses and a few other punctuation chars.
  description = "Per-IP edge rate limits for the API - auth flood / SES-quota protection"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Rule 1: tight per-IP limit on the email-sending auth endpoints.
  rule {
    name     = "auth-rate-limit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_auth_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300

        # Only count requests whose path begins with /api/auth/. Lowercase the
        # path first so case tricks can't dodge the match.
        scope_down_statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/auth/"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-auth-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # Rule 2: loose blanket safety net across all of /api/*.
  rule {
    name     = "api-rate-limit"
    priority = 2

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_api_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300

        scope_down_statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-api-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-${var.environment}-edge"
    sampled_requests_enabled   = true
  }
}
