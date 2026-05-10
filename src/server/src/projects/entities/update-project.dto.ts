// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min
} from "class-validator";

import { ProjectVisibility } from "../../../../shared/constants";
import { ENCODED_BLOB_MAX_LENGTH } from "./create-project.dto";

export class UpdateProjectDto {
  @IsNotEmpty({ message: "Please enter a name for your project" })
  @IsOptional()
  readonly name?: string;

  // Encoded gzip+base64 (or legacy raw JSON) text — see src/shared/compress.ts.
  @IsString()
  @MaxLength(ENCODED_BLOB_MAX_LENGTH, {
    message: "Districts definition is too large to save"
  })
  @IsOptional()
  readonly districtsDefinition?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsOptional()
  readonly lockedDistricts?: readonly boolean[];

  @IsArray()
  @ArrayNotEmpty()
  @IsOptional()
  readonly numberOfMembers?: readonly number[];

  @IsBoolean()
  @IsOptional()
  readonly advancedEditingEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Max(100, { message: "Population deviation must be between 0% and 100%" })
  @Min(0, { message: "Population deviation must be between 0% and 100%" })
  readonly populationDeviation?: number;

  @IsEnum(ProjectVisibility)
  @IsOptional()
  readonly visibility?: ProjectVisibility;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  readonly pinnedMetricFields?: string[];

  @IsBoolean()
  @IsOptional()
  readonly archived?: boolean;

  @IsBoolean()
  @IsOptional()
  readonly isComplete?: boolean;

  @IsString()
  @MaxLength(ENCODED_BLOB_MAX_LENGTH, {
    message: "District properties are too large to save"
  })
  @IsOptional()
  readonly districtProperties?: string;

  @IsString()
  @IsOptional()
  readonly planscoreUrl?: string;
}
