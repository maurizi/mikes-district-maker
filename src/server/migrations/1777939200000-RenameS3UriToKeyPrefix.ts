// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { MigrationInterface, QueryRunner } from "typeorm";

export class RenameS3UriToKeyPrefix1777939200000 implements MigrationInterface {
  name = "RenameS3UriToKeyPrefix1777939200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // DSQL doesn't support ALTER TABLE DROP COLUMN or DROP CONSTRAINT, but it
    // does support RENAME COLUMN and RENAME CONSTRAINT, so the rename happens
    // in place: the column moves to its new name, the values get stripped of
    // their s3:// + bucket prefix, and the backing UNIQUE constraint gets
    // renamed alongside.
    await queryRunner.query(
      `ALTER TABLE "region_config" RENAME COLUMN "s3_uri" TO "key_prefix"`
    );
    await queryRunner.query(
      `UPDATE "region_config" SET "key_prefix" = regexp_replace("key_prefix", '^s3://[^/]+/', '')`
    );
    await queryRunner.query(
      `ALTER TABLE "region_config" RENAME CONSTRAINT "UQ_07cc7193176f7610686f2730492" TO "UQ_region_config_key_prefix"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reconstructing s3_uri requires knowing the bucket the data was uploaded
    // into. Hardcoded to the legacy bucket since that's where every existing
    // RegionConfig row's data actually lives.
    await queryRunner.query(
      `ALTER TABLE "region_config" RENAME CONSTRAINT "UQ_region_config_key_prefix" TO "UQ_07cc7193176f7610686f2730492"`
    );
    await queryRunner.query(
      `UPDATE "region_config" SET "key_prefix" = 's3://districtbuilder-dev-238046523378/' || "key_prefix"`
    );
    await queryRunner.query(
      `ALTER TABLE "region_config" RENAME COLUMN "key_prefix" TO "s3_uri"`
    );
  }
}
