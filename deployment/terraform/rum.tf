# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# CloudWatch RUM for frontend telemetry + structured-log alarm for backend errors.
# Replaces the prior Rollbar + GTM integrations.

# ---------- Cognito identity pool for unauthenticated browser clients ----------

resource "aws_cognito_identity_pool" "rum" {
  identity_pool_name               = "${var.project}-${var.environment}-rum"
  allow_unauthenticated_identities = true
  allow_classic_flow               = true
}

data "aws_iam_policy_document" "rum_guest_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = ["cognito-identity.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "cognito-identity.amazonaws.com:aud"
      values   = [aws_cognito_identity_pool.rum.id]
    }
    condition {
      test     = "ForAnyValue:StringLike"
      variable = "cognito-identity.amazonaws.com:amr"
      values   = ["unauthenticated"]
    }
  }
}

resource "aws_iam_role" "rum_guest" {
  name               = "${var.project}-${var.environment}-rum-guest"
  assume_role_policy = data.aws_iam_policy_document.rum_guest_assume.json
}

data "aws_iam_policy_document" "rum_guest_inline" {
  statement {
    actions   = ["rum:PutRumEvents"]
    resources = [aws_rum_app_monitor.main.arn]
  }
}

resource "aws_iam_role_policy" "rum_guest" {
  role   = aws_iam_role.rum_guest.id
  policy = data.aws_iam_policy_document.rum_guest_inline.json
}

resource "aws_cognito_identity_pool_roles_attachment" "rum" {
  identity_pool_id = aws_cognito_identity_pool.rum.id
  roles = {
    "unauthenticated" = aws_iam_role.rum_guest.arn
  }
}

# ---------- RUM app monitor ----------

resource "aws_rum_app_monitor" "main" {
  name   = "${var.project}-${var.environment}"
  domain = var.domain_name

  cw_log_enabled = true

  app_monitor_configuration {
    allow_cookies       = true
    enable_xray         = false
    session_sample_rate = 1
    telemetries         = ["errors", "performance", "http"]
    identity_pool_id    = aws_cognito_identity_pool.rum.id
    guest_role_arn      = aws_iam_role.rum_guest.arn
  }
}

# ---------- Backend error alarm from structured logs ----------

resource "aws_cloudwatch_log_metric_filter" "api_errors" {
  name           = "${var.project}-${var.environment}-api-errors"
  log_group_name = aws_cloudwatch_log_group.api.name
  # Matches the JSON payload emitted by StructuredLoggerExceptionFilter.
  pattern = "{ $.level = \"error\" }"

  metric_transformation {
    name          = "${var.project}-${var.environment}-ApiErrorCount"
    namespace     = "DistrictBuilder/Api"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_sns_topic" "api_errors" {
  name = "${var.project}-${var.environment}-api-errors"
}

resource "aws_sns_topic_subscription" "api_errors_email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.api_errors.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${var.project}-${var.environment}-api-errors"
  alarm_description   = "Fires when the NestJS API logs one or more unhandled exceptions."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.api_errors.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.api_errors.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.api_errors.arn]
  ok_actions    = [aws_sns_topic.api_errors.arn]
}
