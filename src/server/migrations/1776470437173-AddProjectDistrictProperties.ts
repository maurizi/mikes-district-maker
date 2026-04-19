// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectDistrictProperties1776470437173 implements MigrationInterface {
  name = "AddProjectDistrictProperties1776470437173";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project" ADD COLUMN "district_properties" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project" DROP COLUMN "district_properties"`);
  }
}
