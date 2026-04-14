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

  # Read-only access to the region artifacts bucket.
  statement {
    sid     = "S3ReadArtifacts"
    actions = ["s3:GetObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.region_artifacts.arn,
      "${aws_s3_bucket.region_artifacts.arn}/*"
    ]
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
  handler          = "index.handler"
  filename         = data.archive_file.stub.output_path
  source_code_hash = data.archive_file.stub.output_base64sha256

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  layers = [var.lwa_layer_arn]

  environment {
    variables = {
      # Lambda Web Adapter config: NestJS listens on 3005 (see
      # src/server/src/main.ts) and exposes /healthcheck for readiness.
      AWS_LWA_PORT                 = "3005"
      AWS_LWA_READINESS_CHECK_PATH = "/healthcheck"

      # DSQL connection for src/server/src/data-source.ts.
      DSQL_ENDPOINT = local.dsql_endpoint
      DSQL_USER     = "admin"

      # Region artifacts bucket (consumed via S3_CACHE_DIRECTORY logic in
      # src/server/src/common/functions.ts).
      REGION_ARTIFACTS_BUCKET = aws_s3_bucket.region_artifacts.bucket

      NODE_ENV = var.environment
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

resource "aws_lambda_permission" "alb" {
  statement_id  = "AllowALBInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "elasticloadbalancing.amazonaws.com"
  source_arn    = aws_lb_target_group.api.arn
}
