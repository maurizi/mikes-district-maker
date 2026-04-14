# Deployment

The production stack is managed via Terraform in `./terraform/` — Aurora DSQL
+ Lambda (Node 24 + Lambda Web Adapter) + ALB + CloudFront (two origins: S3
for the Vite build, ALB for `/api/*` and `/healthcheck`).

See [`./terraform/README.md`](./terraform/README.md) for infrastructure bring-up.

## AWS Credentials

Create an AWS profile named `district-builder`:

```bash
aws configure --profile district-builder
```

The CLI + Terraform both honor `AWS_PROFILE=district-builder`.

## Deploying application code

CI handles deploys on pushes to `develop` and `test/*`:

1. Build the client (Vite) and server (NestJS)
2. Package the server as a Lambda zip (`dist/` + production `node_modules`)
3. Sync the client build to the static-assets S3 bucket
4. `aws lambda update-function-code` with the new zip
5. Invalidate CloudFront for `/index.html`

See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) for the full flow.

## Running migrations

Database migrations run from a laptop against the target cluster, using IAM
auth via `DsqlSigner` (see `src/server/src/data-source.ts`):

```bash
export AWS_PROFILE=district-builder
export AWS_REGION=us-east-1
export DSQL_ENDPOINT=$(cd deployment/terraform && terraform output -raw dsql_endpoint)
yarn --cwd src/server migration:run
```

Future migrations must be DSQL-compatible. After generating a migration:

```bash
yarn --cwd src/server migration:generate -d src/data-source.ts migrations/Whatever
yarn --cwd src/server migration:dsql-check migrations/<timestamp>-Whatever.ts
```

The `dsql-check` command auto-rewrites common patterns (`uuid_generate_v4`,
`SERIAL`, `jsonb`, standard indexes) and prints warnings for patterns that
need human judgment (foreign keys, enums, `ADD COLUMN NOT NULL`, partial
indexes, array types, `SET NOT NULL`). See `project_dsql_constraints.md` in
the claude-code memory (or the plan file from the modernization session) for
the full list.

## Seeding region data

The region-artifacts S3 bucket is empty after a fresh Terraform apply. Run
the `manage` CLI locally to populate it with the topojson, metadata, and
hierarchy files for the regions you want live. The server reads from this
bucket on demand and caches to `/tmp` per-invocation.
