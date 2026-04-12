import { MigrationInterface, QueryRunner } from "typeorm";

export class dropDistrictsReshapeThumbnail1776089552957 implements MigrationInterface {
  name = "dropDistrictsReshapeThumbnail1776089552957";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rename simplified_districts → thumbnail. The client now owns this column
    // (computes & POSTs it on save); the column keeps its existing contents so
    // listings keep rendering until each project is next saved.
    await queryRunner.query(`ALTER TABLE "project" RENAME COLUMN "simplified_districts" TO "thumbnail"`);

    // Add is_complete to replace the "completed-projects" listing filter.
    // Backfill from the existing districts geometry probe (the same predicate
    // projects.service.ts used to run at query time).
    await queryRunner.query(`ALTER TABLE "project" ADD "is_complete" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(
      `UPDATE "project" SET "is_complete" = true
       WHERE "districts" IS NOT NULL
         AND jsonb_array_length("districts"->'features'->0->'geometry'->'coordinates')::integer = 0`
    );

    // Districts geometry is fully client-computed; drop the column.
    await queryRunner.query(`ALTER TABLE "project" DROP COLUMN "districts"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project" ADD "districts" jsonb`);
    await queryRunner.query(`ALTER TABLE "project" DROP COLUMN "is_complete"`);
    await queryRunner.query(`ALTER TABLE "project" RENAME COLUMN "thumbnail" TO "simplified_districts"`);
  }
}
