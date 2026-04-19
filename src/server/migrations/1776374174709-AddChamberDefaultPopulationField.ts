// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddChamberDefaultPopulationField1776374174709 implements MigrationInterface {
  name = "AddChamberDefaultPopulationField1776374174709";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chamber" ADD COLUMN "default_population_field" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chamber" DROP COLUMN "default_population_field"`
    );
  }
}
