import { MigrationInterface, QueryRunner } from "typeorm";

// Squashed baseline schema, DSQL-compatible. Replaces all prior migrations.
//
// Departures from what typeorm migration:generate emits for vanilla Postgres:
// - built-in UUID generator instead of the uuid-ossp extension function
// - bigint IDENTITY with explicit CACHE 1 instead of SERIAL
// - varchar + CHECK instead of CREATE TYPE AS ENUM
// - CREATE INDEX ASYNC instead of plain CREATE INDEX
// - No foreign-key constraints (DSQL has none; the app has exactly one DELETE
//   endpoint and no cascade semantics depend on the database)
export class Squash1776135205138 implements MigrationInterface {
  name = "Squash1776135205138";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "region_config" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "country_code" character varying NOT NULL,
        "region_code" character varying NOT NULL,
        "s3_uri" character varying NOT NULL,
        "version" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "hidden" boolean NOT NULL DEFAULT false,
        "archived" boolean NOT NULL DEFAULT false,
        "census" varchar(4) NOT NULL DEFAULT '2020' CHECK ("census" IN ('2010','2020')),
        CONSTRAINT "UQ_07cc7193176f7610686f2730492" UNIQUE ("s3_uri"),
        CONSTRAINT "UQ_d2ee646fdd8506be3d136711909" UNIQUE ("name", "country_code", "region_code", "version"),
        CONSTRAINT "PK_2cc33eabc641c2fc526f2bb20ea" PRIMARY KEY ("id")
      )`
    );
    await queryRunner.query(
      `CREATE TABLE "chamber" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "number_of_districts" integer NOT NULL,
        "number_of_members" text,
        "region_config_id" uuid NOT NULL,
        CONSTRAINT "PK_cde4a9652dfc250c6184b3f6fb4" PRIMARY KEY ("id")
      )`
    );

    await queryRunner.query(
      `CREATE TABLE "project" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "region_config_version" TIMESTAMP WITH TIME ZONE NOT NULL,
        "number_of_districts" integer NOT NULL,
        "districts_definition" text,
        "thumbnail" text,
        "is_complete" boolean NOT NULL DEFAULT false,
        "created_dt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updated_dt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "advanced_editing_enabled" boolean NOT NULL DEFAULT false,
        "locked_districts" text NOT NULL DEFAULT '[]',
        "visibility" varchar(16) NOT NULL DEFAULT 'PUBLISHED' CHECK ("visibility" IN ('PRIVATE','VISIBLE','PUBLISHED')),
        "archived" boolean NOT NULL DEFAULT false,
        "is_featured" boolean NOT NULL DEFAULT false,
        "population_deviation" double precision NOT NULL DEFAULT '5',
        "pinned_metric_fields" text NOT NULL DEFAULT '["population","populationDeviation","raceChart","pvi","compactness"]',
        "number_of_members" text NOT NULL DEFAULT '[]',
        "planscore_url" character varying NOT NULL DEFAULT '',
        "submitted_dt" TIMESTAMP WITH TIME ZONE,
        "region_config_id" uuid NOT NULL,
        "chamber_id" uuid,
        "project_template_id" uuid,
        "user_id" uuid NOT NULL,
        CONSTRAINT "PK_4d68b1358bb5b766d3e78f32f57" PRIMARY KEY ("id")
      )`
    );
    await queryRunner.query(
      `CREATE INDEX ASYNC "IDX_110113f7f5d7d3b08d0c12f5b0" ON "project" ("updated_dt", "user_id")`
    );
    // Community-maps listing: replaces the old IDX_PUBLISHED_PROJECTS that was
    // orphaned when the districts column was dropped (commit dcd846e).
    // Leading filter columns (visibility, archived) let DSQL push them into the
    // index cond; trailing columns support optional completed/region filters;
    // DSQL does backward scans so ORDER BY updated_dt DESC rides the index.
    await queryRunner.query(
      `CREATE INDEX ASYNC "IDX_PUBLISHED_PROJECTS" ON "project" ("visibility", "archived", "updated_dt", "is_complete", "region_config_id")`
    );

    await queryRunner.query(
      `CREATE TABLE "reference_layer" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "layer_type" varchar(16) NOT NULL DEFAULT 'POINT' CHECK ("layer_type" IN ('POLYGON','POINT')),
        "label_field" character varying NOT NULL DEFAULT '',
        "layer" text NOT NULL,
        "layer_color" varchar(16) NOT NULL DEFAULT 'GREEN' CHECK ("layer_color" IN ('GREEN','ORANGE','PURPLE','BLUE','PINK','RED')),
        "project_id" uuid,
        "project_template_id" uuid,
        CONSTRAINT "CHK_4e77a0b7d0479ef3d32e7cc98d" CHECK ("project_id" IS NOT NULL OR "project_template_id" IS NOT NULL),
        CONSTRAINT "PK_10f7a8d2caeaa45f75400d6f3bc" PRIMARY KEY ("id")
      )`
    );

    await queryRunner.query(
      `CREATE TABLE "project_template" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "number_of_districts" integer NOT NULL,
        "districts_definition" text,
        "description" character varying NOT NULL,
        "details" character varying NOT NULL,
        "population_deviation" double precision NOT NULL DEFAULT '5',
        "pinned_metric_fields" text NOT NULL DEFAULT '["population","populationDeviation","raceChart","pvi","compactness"]',
        "number_of_members" text NOT NULL DEFAULT '[]',
        "is_active" boolean NOT NULL DEFAULT true,
        "contest_next_steps" character varying NOT NULL DEFAULT '',
        "contest_active" boolean NOT NULL DEFAULT false,
        "organization_id" uuid NOT NULL,
        "region_config_id" uuid NOT NULL,
        "chamber_id" uuid,
        CONSTRAINT "PK_41cf7a5f5e816a0c36f494283b4" PRIMARY KEY ("id")
      )`
    );

    await queryRunner.query(
      `CREATE TABLE "organization" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        "description" character varying NOT NULL DEFAULT '',
        "logoUrl" character varying NOT NULL DEFAULT '',
        "linkUrl" character varying NOT NULL DEFAULT '',
        "municipality" character varying NOT NULL DEFAULT '',
        "region" character varying NOT NULL DEFAULT '',
        "user_id" uuid,
        CONSTRAINT "UQ_a08804baa7c5d5427067c49a31f" UNIQUE ("slug"),
        CONSTRAINT "PK_472c1f99a32def1b0abb219cd67" PRIMARY KEY ("id")
      )`
    );

    await queryRunner.query(
      `CREATE TABLE "user" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" character varying NOT NULL,
        "name" character varying NOT NULL,
        "isEmailVerified" boolean NOT NULL DEFAULT false,
        "hasSeenTour" boolean NOT NULL DEFAULT false,
        "passwordHash" character varying NOT NULL,
        "created_dt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "last_login_dt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "is_marketing_email_on" boolean NOT NULL DEFAULT false,
        CONSTRAINT "UQ_e12875dfb3b1d92d7d7c5377e22" UNIQUE ("email"),
        CONSTRAINT "PK_cace4a159ff9f2512dd42373760" PRIMARY KEY ("id")
      )`
    );

    await queryRunner.query(
      `CREATE TABLE "email_verification" (
        "id" bigint GENERATED BY DEFAULT AS IDENTITY (CACHE 1) NOT NULL,
        "email" character varying NOT NULL,
        "emailToken" character varying NOT NULL,
        "timestamp" TIMESTAMP NOT NULL,
        "type" varchar(32) NOT NULL CHECK ("type" IN ('forgot password','initial')),
        CONSTRAINT "UQ_40aa9efaef98ed03b98dfcd87f1" UNIQUE ("email", "type"),
        CONSTRAINT "PK_b985a8362d9dac51e3d6120d40e" PRIMARY KEY ("id")
      )`
    );

    await queryRunner.query(
      `CREATE TABLE "organization_users_user" (
        "organizationId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        CONSTRAINT "PK_a0057ab2ced35777f00eaaa9673" PRIMARY KEY ("organizationId", "userId")
      )`
    );
    await queryRunner.query(
      `CREATE INDEX ASYNC "IDX_e1e28e472b43bbad7ff3cecdcd" ON "organization_users_user" ("organizationId")`
    );
    await queryRunner.query(
      `CREATE INDEX ASYNC "IDX_a02d820429038dce37d18f74b6" ON "organization_users_user" ("userId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "organization_users_user"`);
    await queryRunner.query(`DROP TABLE "email_verification"`);
    await queryRunner.query(`DROP TABLE "user"`);
    await queryRunner.query(`DROP TABLE "organization"`);
    await queryRunner.query(`DROP TABLE "project_template"`);
    await queryRunner.query(`DROP TABLE "reference_layer"`);
    await queryRunner.query(`DROP TABLE "project"`);
    await queryRunner.query(`DROP TABLE "chamber"`);
    await queryRunner.query(`DROP TABLE "region_config"`);
  }
}
