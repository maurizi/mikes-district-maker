// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  Max,
  MaxLength,
  Min,
  ValidateIf
} from "class-validator";

import { ChamberIdDto } from "../../chambers/entities/chamber-id.dto";
import { ProjectTemplateIdDto } from "../../project-templates/entities/project-template-id.dto";
import { RegionConfigIdDto } from "../../region-configs/entities/region-config-id.dto";

// DSQL caps text values at 1,048,576 bytes; leave ~8 KiB of row overhead.
export const ENCODED_BLOB_MAX_LENGTH = 1_040_000;
// Cap matches current observed top of production usage. Even fully-coherent
// 1000-district TX maps fit comfortably under the encoded blob cap.
export const MAX_NUMBER_OF_DISTRICTS = 1000;

export class CreateProjectDto {
  @ValidateIf(o => o.projectTemplate?.id === undefined)
  @IsNotEmpty({ message: "Please enter a name for your project" })
  readonly name?: string;

  @ValidateIf(o => o.projectTemplate?.id === undefined)
  @IsInt({ message: "Number of districts must be an integer" })
  @Min(1, { message: "Number of districts must be at least 1" })
  @Max(MAX_NUMBER_OF_DISTRICTS, {
    message: `Number of districts must be ${MAX_NUMBER_OF_DISTRICTS} or less`
  })
  readonly numberOfDistricts?: number;

  @ValidateIf(o => o.projectTemplate?.id === undefined)
  @IsNotEmpty({ message: "Need to supply a region configuration" })
  readonly regionConfig: RegionConfigIdDto;

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
  readonly numberOfMembers?: readonly number[];

  @IsOptional()
  @IsNumber()
  @Max(100, { message: "Population deviation must be between 0% and 100%" })
  @Min(0, { message: "Population deviation must be between 0% and 100%" })
  readonly populationDeviation?: number;

  @IsOptional()
  readonly chamber?: ChamberIdDto;

  @IsOptional()
  readonly projectTemplate?: ProjectTemplateIdDto;

  // Per-district metrics written by the client so the admin CSV export and
  // OG card have data immediately, without waiting for a first save. The PNG
  // image is uploaded separately to S3 (see thumbnail-upload-url endpoint).
  @IsString()
  @MaxLength(ENCODED_BLOB_MAX_LENGTH, {
    message: "District properties are too large to save"
  })
  @IsOptional()
  readonly districtProperties?: string;
}
