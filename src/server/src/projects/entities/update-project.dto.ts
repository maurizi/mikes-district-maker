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
  Min
} from "class-validator";

import { ProjectVisibility } from "../../../../shared/constants";
import type {
  DistrictProperties,
  DistrictsDefinition,
  UpdateProjectData
} from "../../../../shared/entities";

export class UpdateProjectDto implements UpdateProjectData {
  @IsNotEmpty({ message: "Please enter a name for your project" })
  @IsOptional()
  readonly name?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsOptional()
  readonly districtsDefinition?: DistrictsDefinition;

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

  @IsArray()
  @IsOptional()
  readonly districtProperties?: readonly DistrictProperties[];

  @IsString()
  @IsOptional()
  readonly planscoreUrl?: string;
}
