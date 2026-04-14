# Serverless Infrastructure: Lambda + Aurora DSQL

## Context

This ADR is the successor to [ADR-04](./adr-04-server-side-static-data-loading.md)
and [ADR-05](./adr-05-server-concurrency-strategy.md). Both of those sized
infrastructure around a server that held geographic data in memory and
computed district geometry per request. Since they were written, a series
of refactors on the `modernize` branch inverted that model: the server is
now a thin metadata API, and all geographic computation happens in the
browser. The new infrastructure decision would not be possible without
those refactors. A short inventory is worth including here because the
"why" of the new stack only makes sense against the "what changed":

- **Topology moved client-side** (`a07b7c7` "Remove topology references
  from server code"). Under ADR-04 the server loaded every state's
  TopoJSON into memory at startup — this was the dominant reason Fargate
  tasks were sized at 12 GiB and why a multi-minute warm-up was needed
  before a task could accept traffic. The browser now fetches per-region
  topology directly from S3 on demand. The server no longer opens these
  files at all.

- **Per-region metadata moved client-side** (`0e34200` "Refactor: remove
  need for geo-properties.json on the server"). A second class of
  per-region files that the server used to load and cache also moved to
  the browser. The server's remaining S3 reads are for a small set of
  lightweight JSON artifacts (`static-metadata.json`,
  `geounit-hierarchy.json`, `block-ids.json`) that it fetches lazily and
  caches to local disk — a pattern that fits Lambda's `/tmp` ephemeral
  storage naturally, with no startup warm-up required.

- **The `districts` JSONB column was removed from the `project` table**
  (`dcd846e` "Remove full districts column from the database, always
  recreate clientside"). The database now stores only
  `districtsDefinition` — a compact per-block integer array of district
  assignments — plus a small client-written `thumbnail` GeoJSON used for
  project-listing previews. The full, renderable district geometry is
  rebuilt in the browser from `districtsDefinition` + topology whenever
  a project is opened. The write path for a save is now a sub-megabyte
  JSON PATCH instead of tens of megabytes of GeoJSON.

- **PlanScore submission became a thin proxy**
  (`projects.controller.ts: planScoreUploadCredentials`,
  `planScoreFinalize`). The server holds the PlanScore bearer token but
  never touches the submitted GeoJSON — the browser retrieves signed
  upload credentials from our server and then POSTs the GeoJSON directly
  to PlanScore's S3 bucket. This was the last place on the server where
  a full district GeoJSON ever appeared in memory.

After all of this, the server's hot path is small-payload CRUD over
project metadata plus a couple of upload-credential proxies. There is no
state held in process across requests, nothing loaded at startup that
takes nontrivial time, and no per-request memory pressure proportional
to state complexity. In other words, the server is finally shaped like
something you would deploy on Lambda.

At the same time, several other things became worth fixing:

- The pinned AWS provider (`~> 3.75.1`) and Postgres major version (12,
  EOL) were both old enough that a forced upgrade was already overdue.
- The infrastructure was overprovisioned for the current (fork) traffic
  profile. Idle cost dominated runtime cost.
- This codebase is now a fork of DistrictBuilder. There is no existing
  production database to cut over from, so the migration is a greenfield
  stand-up rather than a zero-downtime replace — that removes the hardest
  part of most infra migrations and opens the door to options we wouldn't
  otherwise consider.

Three candidate target architectures were evaluated:

1. **Lambda + Aurora DSQL** (the choice, detailed below).
2. **Lambda + Aurora Serverless v2 with `min_capacity = 0 ACU`.** Same
   Lambda shape, but a Postgres-compatible database that does scale to zero
   (GA in late 2024). Pros: keeps vanilla TypeORM patterns — no schema or
   entity rewrites — and preserves full Postgres semantics (FKs, enums,
   jsonb, partial indexes). Cons: needs a VPC for Lambda to reach the
   cluster privately, needs RDS Proxy to queue connections through the
   ~15s wake-up from zero (which adds $15–22/mo and doesn't itself scale
   to zero), needs Secrets Manager for credentials rotation, and the wake
   latency shows up on cold API calls. This is the stronger fallback if
   DSQL ever proves untenable for this codebase.
3. **Keep ECS Fargate, modernize Terraform only.** Lowest-change path.
   Fails the idle-cost driver: Fargate has no scale-to-zero story, and
   even minimal capacity plus RDS is several times more expensive than
   the other two options at fork traffic levels.

## Decision

The new stack is:

```
Browser ──> CloudFront
               ├─> S3 (Vite build: HTML, JS, CSS)    ← loads instantly, always
               └─> ALB → Lambda (nodejs24.x + LWA, NestJS)
                              ├─> Aurora DSQL (scale-to-zero, Postgres-compat)
                              └─> S3 region artifacts (read on demand, /tmp cache)

Browser ──> PlanScore S3 (direct upload, bypasses our infra)
```

Key component choices:

- **Aurora DSQL** as the database. Scale-to-zero, no VPC, no connection
  pooler, IAM auth. See constraints and the surprise audit below.
- **Lambda managed `nodejs24.x` runtime**, arm64, with the public Lambda
  Web Adapter layer. LWA wraps the existing NestJS HTTP server without
  rewriting anything as a Lambda handler: `main.ts` still calls
  `app.listen(3005)` and LWA forwards Lambda events to that port. Zero
  NestJS code changes in the request-handling path.
- **ALB → Lambda target group**, not API Gateway. Simpler cost model and
  reuses the `/healthcheck` pattern the existing app exposes. All Lambda
  front-ends share the same ~5 MB effective request body ceiling (Lambda's
  6 MB sync invoke payload minus headers and base64 overhead); that
  ceiling matters for exactly one endpoint (see consequences).
- **CloudFront distribution with two origins**: S3 for the Vite build
  (default behavior) and the ALB for `/api/*` and `/healthcheck`. This
  decouples page-load latency from cold-path API latency — the app shell
  is always one CloudFront edge hit away even if the Lambda or database
  is cold.
- **No VPC, no RDS Proxy, no Secrets Manager, no NAT gateway**. DSQL is
  reached over a public endpoint with IAM auth, and S3 is likewise public.
  Lambda runs outside any VPC.
- **No `manage` deployment**. The `src/manage` CLI is used by a developer
  from a laptop against whichever target database is current; it now
  speaks DSQL via `DsqlSigner` when `DSQL_ENDPOINT` is set.

### The DSQL gotcha

DSQL is PostgreSQL-compatible over the wire but is not drop-in Postgres.
A migration audit surfaced a set of hard structural limitations that
together forced a rewrite of the baseline schema and every entity file.
For a full enumeration see the
[AWS data-types reference](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html)
and the `project_dsql_constraints.md` memory. The load-bearing ones:

- **`json` and `jsonb` are runtime-only types**, not storage types. JSON
  data is stored in `text` columns and cast at query time. TypeORM's
  `simple-json` column type does this transparently; it serializes on
  write and parses on read, so application code never sees the storage
  form.
- **No array column types.** Postgres `integer[]`, `boolean[]`,
  `varchar[]` — all rejected at CREATE TABLE. Anywhere we used these
  (`locked_districts`, `pinned_metric_fields`, `number_of_members`) now
  uses `simple-json`.
- **No `CREATE TYPE ... AS ENUM`.** Enum columns become `varchar(N)` with
  a `CHECK (col IN (...))` constraint.
- **No foreign keys.** Relational integrity moves entirely to the
  application layer. Verified that the app has exactly one `DELETE`
  endpoint (on `reference_layer`) and no cascade semantics depend on
  database enforcement.
- **No partial indexes** (`CREATE INDEX ... WHERE`) and no
  `DESC`/`ASC` sort order on index keys. DSQL does backward index scans
  natively, so a composite index without direction still serves
  `ORDER BY ... DESC` queries efficiently.
- **No `ALTER TABLE ADD COLUMN ... NOT NULL`** and no
  `ALTER COLUMN ... SET NOT NULL`. Every NOT NULL column must be declared
  in the original `CREATE TABLE`. This is the single most operationally
  disruptive constraint going forward.
- **No DDL + DML in the same transaction**, which breaks TypeORM's
  built-in migration runner (it wraps DDL + the INSERT into `migrations`
  in one transaction). The runtime framework migration runner uses
  `transaction: "none"`, and we pre-create the `migrations` tracking
  table manually with `bigint GENERATED BY DEFAULT AS IDENTITY (CACHE 1)`
  before framework code runs.
- **No `SERIAL` or `int` IDENTITY.** Identity columns must be `bigint`
  with an explicit `CACHE` clause.

All 62 accumulated migrations were squashed into a single DSQL-native
baseline (`src/server/migrations/*-Squash.ts`) to sidestep the
"never add NOT NULL later" problem, since on a greenfield fork there is
no migration history to preserve.

## Consequences

**What we gain**

- **Idle cost**: Lambda at zero invocations and DSQL at zero DPU-hours
  are both free. ALB is the dominant idle cost at ~$0.54/day. Total idle
  is under $1/day versus the old Fargate + RDS floor of several hundred
  dollars a month.
- **True scale-to-zero page loads**. Cold-path users hit CloudFront + S3
  for HTML/JS/CSS, which is always warm. They only wait on Lambda/DSQL
  if and when they make an API call, and DSQL has no measurable cold-wake
  delay (unlike the ~15s Serverless v2 case).
- **Dramatic operational simplification**. No VPC, no RDS Proxy, no
  Secrets Manager rotation, no NAT gateway, no bastion host, no ECS
  cluster, no Auto Scaling Group, no task definitions, no scheduled
  EventBridge jobs. The new Terraform is roughly a tenth the size of the
  old stack.
- **A better community-maps query than production had.** The old
  `IDX_PUBLISHED_PROJECTS` was a partial functional index that referenced
  the now-removed `districts` column — it had been orphaned since
  `dcd846e` and the query had been falling back to a sequential scan
  since. The new composite index (`visibility`, `archived`, `updated_dt`,
  `is_complete`, `region_config_id`) is plain, DSQL-compatible, and gets
  `Index Scan Backward` with filter pushdown and limit pushdown.

**What we give up**

- **Database-level referential integrity**. FKs are gone. Orphan inserts
  and stale references become application bugs rather than database
  errors. Low practical risk given the single-DELETE-endpoint profile,
  but worth noting.
- **Partial uniqueness on `region_config`**. The old index allowed the
  "retire a region (mark hidden) and create a new one with the same
  country+region code" pattern via `WHERE hidden <> TRUE`. DSQL has no
  partial indexes, and we judged the alternative (a plain unique index
  that blocks the retire-and-recreate workflow) worse than dropping
  uniqueness entirely. The four-column `(name, country, region, version)`
  unique constraint still prevents exact duplicates, and the
  admin-create endpoint is the only path that inserts region configs.
- **Shapefile export runs in the browser now**, not on the server. The
  server endpoint and `geojson2shp` dependency are gone, replaced by
  `@mapbox/shp-write` on the client. This would have been forced
  eventually even on a real-Postgres Lambda: a full district GeoJSON at
  large-state scale can exceed Lambda's ~5 MB request-body ceiling.
- **Permanent migration tax**. TypeORM's `migration:generate` emits
  standard Postgres DDL (jsonb, arrays, FKs, SERIAL, standard indexes,
  ADD COLUMN NOT NULL). Every auto-generated migration must be rewritten
  for DSQL compatibility. This is partially automated by
  `yarn migration:dsql-check`, which auto-rewrites the mechanical cases
  (uuid generator, SERIAL, jsonb/json, index mode, sort direction) and
  prints warnings for the structural cases (enums, FKs, partial indexes,
  ADD COLUMN NOT NULL, array types, SET NOT NULL, CREATE EXTENSION) with
  concrete hints. The script operates only on backtick-delimited SQL
  strings inside migration files, so TypeScript comments and non-SQL
  strings are not touched.
- **NOT NULL columns must be declared at CREATE TABLE time**. Adding a
  new required column to an existing table requires either (1) adding
  it as nullable and enforcing NOT NULL at the app layer, or (2)
  re-squashing the schema, which is only tractable on a fresh database.
  We should expect to take option 1 in almost all cases.
- **No `REINDEX`**. DSQL manages its own storage and does not expose
  reindex semantics. The scheduled `reindex` job (formerly an EventBridge
  target against the ECS task definition) was deleted; it wouldn't have
  done anything on DSQL even if we had kept it.
- **Ongoing DSQL lock-in**. Switching away from DSQL would require
  re-squashing entities back to enum/jsonb/array forms and restoring FK
  decorators. Not technically difficult but not free. Aurora Serverless
  v2 remains a viable fallback target if DSQL ever becomes operationally
  untenable for this project.
