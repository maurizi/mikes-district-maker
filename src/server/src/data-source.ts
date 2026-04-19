// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { join } from "path";
import { DataSource, type DataSourceOptions } from "typeorm";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { EmailVerification } from "./auth/entities/email-verification.entity";
import { Chamber } from "./chambers/entities/chamber.entity";
import { Organization } from "./organizations/entities/organization.entity";
import { Project } from "./projects/entities/project.entity";
import { ProjectTemplate } from "./project-templates/entities/project-template.entity";
import { ReferenceLayer } from "./reference-layers/entities/reference-layer.entity";
import { RegionConfig } from "./region-configs/entities/region-config.entity";
import { User } from "./users/entities/user.entity";

// Shared TypeORM data source for both DSQL (prod) and vanilla Postgres
// (local docker-compose dev). DSQL is selected when DSQL_ENDPOINT is set:
// the signer mints IAM auth tokens that typeorm uses as the pg password,
// SSL is required, and connection-pool lifetime is kept under the token
// expiry window.
//
// Settings kept identical across both targets (so future migration:generate
// output is DSQL-compatible by default):
// - uuidExtension: "pgcrypto" → UUID columns use gen_random_uuid(), built
//   into Postgres 13+ (no extension install needed)
// - installExtensions: false → typeorm never tries CREATE EXTENSION at
//   startup; every runtime dep is Postgres-built-in
// - migrationsTransactionMode: "none" → each migration runs outside a
//   transaction, since DSQL rejects DDL+DML and multi-DDL in one txn
//   (harmless on vanilla Postgres)
const endpoint = process.env.DSQL_ENDPOINT;
const region = process.env.AWS_REGION || "us-east-1";
const username = process.env.DSQL_USER || "admin";

const signer = endpoint ? new DsqlSigner({ hostname: endpoint, region }) : undefined;

const getPassword = async (): Promise<string> => {
  if (signer) {
    return username === "admin"
      ? signer.getDbConnectAdminAuthToken()
      : signer.getDbConnectAuthToken();
  }
  return process.env.POSTGRES_PASSWORD || "";
};

const sharedOptions = {
  type: "postgres" as const,
  synchronize: false,
  logging: process.env.NODE_ENV === "Development",
  installExtensions: false,
  uuidExtension: "pgcrypto" as const,
  migrationsTransactionMode: "none" as const,
  entities: [
    EmailVerification,
    Chamber,
    Organization,
    Project,
    ProjectTemplate,
    ReferenceLayer,
    RegionConfig,
    User
  ],
  migrations: [join(__dirname, "../migrations/*.{js,ts}")]
};

export const dataSourceOptions: DataSourceOptions = endpoint
  ? ({
      ...sharedOptions,
      host: endpoint,
      port: 5432,
      username,
      password: getPassword,
      database: "postgres",
      ssl: { rejectUnauthorized: true },
      extra: {
        min: 0,
        max: 5,
        idleTimeoutMillis: 600_000,
        connectionTimeoutMillis: 30_000,
        maxLifetimeSeconds: 3300
      }
    } as DataSourceOptions)
  : {
      ...sharedOptions,
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB
    };

export default new DataSource(dataSourceOptions);
