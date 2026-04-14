import { DataSource, DataSourceOptions } from "typeorm";
import { DsqlSigner } from "@aws-sdk/dsql-signer";

import { Chamber } from "../../../server/src/chambers/entities/chamber.entity";
import { Organization } from "../../../server/src/organizations/entities/organization.entity";
import { ProjectTemplate } from "../../../server/src/project-templates/entities/project-template.entity";
import { ReferenceLayer } from "../../../server/src/reference-layers/entities/reference-layer.entity";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { User } from "../../../server/src/users/entities/user.entity";
import { Project } from "../../../server/src/projects/entities/project.entity";

// Mirrors src/server/src/data-source.ts — DSQL when DSQL_ENDPOINT is set,
// vanilla Postgres otherwise, with identical uuid/extension/migration-txn
// settings so both paths share a single migration-emit shape.
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

const entities = [
  Chamber,
  Organization,
  ProjectTemplate,
  RegionConfig,
  ReferenceLayer,
  User,
  Project
];

const sharedOptions = {
  type: "postgres" as const,
  entities,
  logging: true,
  synchronize: false,
  installExtensions: false,
  uuidExtension: "pgcrypto" as const
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

export async function createDataSource(): Promise<DataSource> {
  const ds = new DataSource(dataSourceOptions);
  await ds.initialize();
  return ds;
}
