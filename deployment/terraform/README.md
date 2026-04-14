# terraform

Aurora DSQL + Lambda (Node 24 + LWA) + ALB + CloudFront (two origins: S3 for
the Vite build, ALB for `/api/*` and `/healthcheck`).

## TODO before first apply

1. **Backend**: fill in the S3 state bucket in `versions.tf` (or pass via
   `terraform init -backend-config=...`).

2. **LWA layer ARN**: set `lwa_layer_arn` to the current public Lambda Web
   Adapter layer for your region + architecture. See the table at
   https://github.com/awslabs/aws-lambda-web-adapter for current ARNs.
   For `us-east-1` + `arm64` this is currently:
   `arn:aws:lambda:us-east-1:753240598075:layer:LambdaAdapterLayerArm64:25`
   (verify before applying — layer versions move).

3. **Domain + Route53**: set `domain_name` and `route53_zone_name`. The
   hosted zone must exist in the target account before apply, and ACM DNS
   validation is automated only when `route53_zone_name` is set.

4. **Default VPC**: `alb.tf` uses the account's default VPC and its default
   subnets for the ALB. If the default VPC has been deleted in this account,
   swap `data.aws_vpc.default` for an explicit `aws_vpc` resource.

5. **Environment variables on the Lambda**: `lambda.tf` sets the DSQL
   connection and region-artifacts bucket env vars. Add any additional env
   vars the server needs (JWT secret, Rollbar token, PlanScore token,
   mail-from address, etc.) before traffic hits the Lambda.

## First apply

```bash
export AWS_PROFILE=district-builder
terraform init
terraform plan -var environment=production -var domain_name=app.example.com -var route53_zone_name=example.com -var lwa_layer_arn=<arn>
terraform apply ...
```

The first apply creates the Lambda with a placeholder handler (returns HTTP
503). Run CI (or `scripts/deploy-lambda`) to push the real NestJS bundle.

## Running migrations against the new DB

```bash
DSQL_ENDPOINT=$(terraform output -raw dsql_endpoint) \
  AWS_PROFILE=district-builder AWS_REGION=us-east-1 \
  yarn --cwd src/server migration:run
```

## Seeding region artifacts

The region-artifacts S3 bucket is created empty. Run the `manage` CLI
locally with `S3_BUCKET=$(terraform output -raw region_artifacts_bucket)`
(or equivalent env var for the commands that populate it) to load region
data. The server will read this bucket on demand and cache in /tmp.
