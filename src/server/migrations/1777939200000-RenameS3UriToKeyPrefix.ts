// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { MigrationInterface, QueryRunner } from "typeorm";

export class RenameS3UriToKeyPrefix1777939200000 implements MigrationInterface {
  name = "RenameS3UriToKeyPrefix1777939200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // DSQL doesn't accept ADD COLUMN NOT NULL, so the new column is nullable
    // at the DB level; non-null is enforced at the app layer (publish-region
    // always sets it, and the existing rows are populated below).
    const indexMode = process.env.DSQL_ENDPOINT ? "INDEX ASYNC" : "INDEX";

    await queryRunner.query(
      `ALTER TABLE "region_config" DROP CONSTRAINT "UQ_07cc7193176f7610686f2730492"`
    );
    await queryRunner.query(
      `ALTER TABLE "region_config" ADD COLUMN "key_prefix" character varying`
    );
    await queryRunner.query(
      `UPDATE "region_config" SET "key_prefix" = regexp_replace("s3_uri", '^s3://[^/]+/', '')`
    );
    await queryRunner.query(`ALTER TABLE "region_config" DROP COLUMN "s3_uri"`);
    await queryRunner.query(
      `CREATE UNIQUE ${indexMode} "UQ_region_config_key_prefix" ON "region_config" ("key_prefix")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reconstructing s3_uri requires knowing the bucket the data was uploaded
    // into. Hardcoded to the legacy bucket since that's where every existing
    // RegionConfig row's data actually lives.
    const indexMode = process.env.DSQL_ENDPOINT ? "INDEX ASYNC" : "INDEX";

    await queryRunner.query(`DROP INDEX "UQ_region_config_key_prefix"`);
    await queryRunner.query(
      `ALTER TABLE "region_config" ADD COLUMN "s3_uri" character varying`
    );
    await queryRunner.query(
      `UPDATE "region_config" SET "s3_uri" = 's3://districtbuilder-dev-238046523378/' || "key_prefix"`
    );
    await queryRunner.query(`ALTER TABLE "region_config" DROP COLUMN "key_prefix"`);
    await queryRunner.query(
      `CREATE UNIQUE ${indexMode} "UQ_07cc7193176f7610686f2730492" ON "region_config" ("s3_uri")`
    );
  }
}
