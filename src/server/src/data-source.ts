import { join } from "path";
import { DataSource, DataSourceOptions } from "typeorm";
import { DsqlSigner } from "@aws-sdk/dsql-signer";

// DSQL connection: IAM auth via DsqlSigner, token refreshed per connection.
// DSQL rejects extension installs and uses gen_random_uuid() for UUID defaults
// (via uuidExtension: "pgcrypto"). Migration-tracking and DDL rules require
// running migrations with transaction: "none" — see the migration runner in
// src/commands/run-migrations.ts.
const endpoint = process.env.DSQL_ENDPOINT;
const region = process.env.AWS_REGION || "us-east-1";
const username = process.env.DSQL_USER || "admin";

const signer = endpoint
  ? new DsqlSigner({ hostname: endpoint, region })
  : undefined;

const getPassword = async (): Promise<string> => {
  if (signer) {
    return username === "admin"
      ? signer.getDbConnectAdminAuthToken()
      : signer.getDbConnectAuthToken();
  }
  return process.env.POSTGRES_PASSWORD || "";
};

export const dataSourceOptions: DataSourceOptions = endpoint
  ? {
      type: "postgres",
      host: endpoint,
      port: 5432,
      username,
      password: getPassword,
      database: "postgres",
      ssl: { rejectUnauthorized: true },
      synchronize: false,
      logging: process.env.NODE_ENV === "Development",
      installExtensions: false,
      uuidExtension: "pgcrypto",
      // DSQL rejects DDL+DML and multi-DDL in a single transaction, so we
      // run each migration with no transaction wrapper.
      migrationsTransactionMode: "none",
      entities: [join(__dirname, "**/*.entity.{js,ts}")],
      migrations: [join(__dirname, "../migrations/*.{js,ts}")],
      extra: {
        min: 0,
        max: 5,
        idleTimeoutMillis: 600_000,
        connectionTimeoutMillis: 30_000,
        maxLifetimeSeconds: 3300
      }
    } as DataSourceOptions
  : {
      // Local dev path: vanilla Postgres via docker-compose.
      type: "postgres",
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      logging: process.env.NODE_ENV === "Development",
      synchronize: false,
      entities: [join(__dirname, "**/*.entity.{js,ts}")],
      migrations: [join(__dirname, "../migrations/*.{js,ts}")]
    };

export default new DataSource(dataSourceOptions);
