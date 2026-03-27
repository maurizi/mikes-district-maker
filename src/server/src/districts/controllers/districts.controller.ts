import {
  Controller,
  InternalServerErrorException,
  Post,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  Query
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { S3Client } from "@aws-sdk/client-s3";
import csvParse from "csv-parse";
import { Express } from "express";

import {
  DistrictsDefinition,
  GeoUnitHierarchy,
  ImportRowFlag,
  DistrictsImportApiResponse,
  DistrictImportField,
  RegionConfigId
} from "../../../../shared/entities";
import { FIPS, MAX_IMPORT_ERRORS } from "../../../../shared/constants";

import { RegionConfigsService } from "../../region-configs/services/region-configs.service";
import { fetchCachedJson } from "../../common/functions";

const s3 = new S3Client({});

function importCsvToDefinition(
  blockIds: readonly string[],
  geoUnitHierarchy: GeoUnitHierarchy,
  blockToDistrict: { readonly [blockId: string]: number }
): DistrictsDefinition {
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < blockIds.length; i++) {
    idToIndex.set(blockIds[i], i);
  }
  const assignment = new Uint8Array(blockIds.length);
  for (const [blockId, district] of Object.entries(blockToDistrict)) {
    const idx = idToIndex.get(blockId);
    if (idx !== undefined) {
      assignment[idx] = district;
    }
  }
  function walk(hierarchy: GeoUnitHierarchy | number): DistrictsDefinition | number {
    if (typeof hierarchy === "number") {
      return assignment[hierarchy];
    }
    const results: (DistrictsDefinition | number)[] = hierarchy.map(h => walk(h));
    if (results.length !== 1 && results.every(item => item === results[0])) {
      return results[0];
    }
    return results;
  }
  return walk(geoUnitHierarchy) as DistrictsDefinition;
}

@Controller("api/districts")
export class DistrictsController {
  constructor(
    private readonly regionConfigService: RegionConfigsService
  ) {}

  @UseInterceptors(FileInterceptor("file"))
  @Post("import/csv")
  @HttpCode(200)
  async importCsv(
    @UploadedFile() file: Express.Multer.File,
    @Query("regionConfigId") regionConfigId?: RegionConfigId
  ): Promise<DistrictsImportApiResponse> {
    /* eslint-disable */
    const parser = csvParse(file.buffer, { fromLine: 2 });
    let records: [string, string][] = [];
    // Seemingly the simplest way of getting all the records into an array is to iterate in a for-loop :(
    for await (const record of parser) {
      records.push(record);
    }
    /* eslint-enable */

    // Array of flagged rows to be returned
    const flaggedRows: ImportRowFlag[] = [];

    function setFlag(
      row: readonly string[],
      rowNumber: number,
      field: DistrictImportField,
      errorText: string
    ) {
      const flag = { rowNumber: rowNumber, errorText: errorText, rowValue: row, field: field };
      // eslint-disable-next-line functional/immutable-data
      flaggedRows[rowNumber] = flag;
    }
    const stateFips: string = records[0][0]?.slice(0, 2);
    if (!(stateFips in FIPS)) {
      throw new InternalServerErrorException();
    }

    const regionCode = FIPS[stateFips];
    const regionConfig = await this.regionConfigService.findOne({
      where: regionConfigId
        ? { id: regionConfigId, archived: false }
        : {
            regionCode,
            hidden: false,
            archived: false
          }
    });
    if (!regionConfig) {
      throw new InternalServerErrorException();
    }

    const blockIdCounts: {
      [blockId: string]: number;
    } = {};

    // Iterate through records to flag invalid rows
    records.forEach((record, i) => {
      const rowFips = record[0]?.slice(0, 2);
      const blockId = record[0];
      // eslint-disable-next-line functional/immutable-data
      blockIdCounts[blockId] = blockIdCounts[blockId] ? blockIdCounts[blockId] + 1 : 1;
      // Check to see if row fips is valid
      if (!(rowFips in FIPS)) {
        setFlag(record, i, "BLOCKID", "Invalid FIPS code");
      }

      // Check to see if rows match state fips
      if (rowFips !== stateFips && !flaggedRows[i]) {
        setFlag(record, i, "BLOCKID", "All geounits in an import must be within the same state");
      }

      // Check for duplicate block IDs
      if (blockIdCounts[blockId] > 1 && !flaggedRows[i]) {
        setFlag(record, i, "BLOCKID", "Duplicate BLOCKID included in import");
      }

      if (isNaN(Number(record[1])) && !flaggedRows[i]) {
        setFlag(record, i, "DISTRICT", "Invalid district ID, must be numeric");
      }
    });

    const unflaggedRows = records.filter((record, i) => !flaggedRows[i]);

    // Fetch block IDs and hierarchy from S3 with disk cache
    const [blockIds, geoUnitHierarchy] = await Promise.all([
      fetchCachedJson<string[]>(s3, regionConfig.s3URI, "block-ids.json"),
      fetchCachedJson<GeoUnitHierarchy>(s3, regionConfig.s3URI, "geounit-hierarchy.json")
    ]);

    // Find unmatched records
    const allBlockIds: Set<string> = new Set(blockIds);
    const invalidRecords = records.filter((record, i) => {
      if (!allBlockIds.has(record[0]) && !flaggedRows[i]) {
        setFlag(record, i, "BLOCKID", "Invalid block ID");
        return true;
      }
      return false;
    });

    // This is a heuristic more than an exact detection method, but it seems sufficient from my testing
    if (invalidRecords.length > MAX_IMPORT_ERRORS) {
      return {
        error: `There were ${invalidRecords.length} invalid block IDs for ${regionCode}, ensure the CSV uploaded is for the Census year ${regionConfig?.census}`
      };
    }

    const blockToDistricts = Object.fromEntries(
      unflaggedRows.map(([block, district]) => [block, Number(district)])
    );
    const districtsDefinition = importCsvToDefinition(blockIds, geoUnitHierarchy, blockToDistricts);

    const maxDistrictId = Object.values(blockToDistricts).reduce((a, b) => Math.max(a, b), 0);
    const rowFlags = flaggedRows.filter(r => !!r);
    const numFlags = rowFlags.length;

    return {
      districtsDefinition,
      maxDistrictId,
      numFlags: numFlags || undefined,
      rowFlags: numFlags > 0 ? rowFlags.slice(0, MAX_IMPORT_ERRORS) : undefined
    };
  }
}
