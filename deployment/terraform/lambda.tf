# SPDX-License-Identifier: AGPL-3.0-or-later
# Modifications © 2026 Michael Maurizi Jr.

data "archive_file" "stub" {
  type        = "zip"
  source_dir  = "${path.module}/lambda-stub"
  output_path = "${path.module}/build/lambda-stub.zip"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.project}-${var.environment}-api"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "api_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.project}-${var.environment}-api"
  assume_role_policy = data.aws_iam_policy_document.api_assume.json
}

resource "aws_iam_role_policy_attachment" "api_basic" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "api_inline" {
  # DSQL connect via IAM auth: the DsqlSigner uses dsql:DbConnectAdmin to mint
  # an auth token, then authenticates to Postgres with it.
  statement {
    sid       = "DsqlConnect"
    actions   = ["dsql:DbConnectAdmin"]
    resources = [aws_dsql_cluster.main.arn]
  }

  # Read-only access to the region artifacts bucket. The bucket itself has a
  # public-read policy today, so the IAM grant is belt-and-suspenders for when
  # we eventually lock it down behind CloudFront OAC.
  statement {
    sid     = "S3ReadArtifacts"
    actions = ["s3:GetObject", "s3:ListBucket"]
    resources = [
      "arn:aws:s3:::${var.region_artifacts_bucket}",
      "arn:aws:s3:::${var.region_artifacts_bucket}/*"
    ]
  }

  # Write access to the project-thumbnails bucket, needed to presign PUT
  # URLs the client uses to upload rendered thumbnails.
  statement {
    sid       = "S3WriteThumbnails"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.thumbnails.arn}/*"]
  }

  # Send transactional email via SES. Used by @nestjs-modules/mailer for
  # registration verification + password reset. Scope to identities we own
  # so a leak of these credentials can't be used to spam from arbitrary
  # senders. `SendRawEmail` is what nodemailer's SES transport actually
  # calls; `SendEmail` is added for any direct uses.
  statement {
    sid       = "SESSend"
    actions   = ["ses:SendRawEmail", "ses:SendEmail"]
    resources = ["arn:aws:ses:${var.aws_region}:*:identity/*"]
  }
}

resource "aws_iam_role_policy" "api_inline" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_inline.json
}

resource "aws_lambda_function" "api" {
  function_name    = "${var.project}-${var.environment}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs24.x"
  architectures    = [var.lambda_architecture]
  memory_size      = var.lambda_memory_mb
  timeout          = var.lambda_timeout_seconds
  handler          = "run.sh"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  layers = [var.lwa_layer_arn]

  environment {
    variables = {
      # LWA's bootstrap is invoked as a wrapper; it execs $_HANDLER (run.sh).
      AWS_LAMBDA_EXEC_WRAPPER = "/opt/bootstrap"

      # Lambda Web Adapter config: NestJS listens on 3005 (see
      # src/server/src/main.ts) and exposes /healthcheck for readiness.
      AWS_LWA_PORT                 = "3005"
      AWS_LWA_READINESS_CHECK_PATH = "/healthcheck"

      # DSQL connection for src/server/src/data-source.ts.
      DSQL_ENDPOINT = local.dsql_endpoint
      DSQL_USER     = "admin"

      # Region artifacts bucket consumed by s3Options() in
      # src/server/src/common/functions.ts. The keyPrefix from each
      # RegionConfig row is appended to this bucket to form the full S3 key.
      REGION_ARTIFACTS_BUCKET = var.region_artifacts_bucket

      # Destination bucket for client-uploaded project thumbnails. Presigned
      # PUT URLs are minted against this bucket in ProjectsController.
      THUMBNAILS_BUCKET = aws_s3_bucket.thumbnails.bucket

      NODE_ENV = var.environment

      # Application secrets and config. Sourced from production.tfvars which
      # is gitignored. JWT_SECRET is marked sensitive so it won't appear in
      # terraform plan output.
      JWT_SECRET           = var.jwt_secret
      JWT_EXPIRATION_IN_MS = tostring(var.jwt_expiration_ms)
      CLIENT_URL           = "https://${var.domain_name}"
      DEFAULT_FROM_EMAIL   = var.default_from_email
      PLAN_SCORE_API_TOKEN = var.plan_score_api_token
    }
  }

  # The stub zip stays under terraform's management; CI rotates the real
  # code via `aws lambda update-function-code` which only touches the code,
  # not this resource's other attributes. Ignore the code fields on refresh
  # so terraform doesn't try to reapply the stub after a real deploy.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [
    aws_cloudwatch_log_group.api,
    aws_iam_role_policy.api_inline
  ]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
  invoke_mode        = "BUFFERED"
}

locals {
  # CloudFront needs just the hostname, not the full URL.
  lambda_url_host = replace(replace(aws_lambda_function_url.api.function_url, "https://", ""), "/", "")
}
