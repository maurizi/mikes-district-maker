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
  const idToIndex = new Map(blockIds.map((id, i): readonly [string, number] => [id, i]));
  const mutableAssignment = new Uint8Array(blockIds.length);
  Object.entries(blockToDistrict).forEach(([blockId, district]) => {
    const idx = idToIndex.get(blockId);
    if (idx !== undefined) {
      mutableAssignment[idx] = district;
    }
  });
  function walk(hierarchy: GeoUnitHierarchy | number): DistrictsDefinition | number {
    if (typeof hierarchy === "number") {
      return mutableAssignment[hierarchy];
    }
    const results: (DistrictsDefinition | number)[] = hierarchy.map(h => walk(h));
    const first = results[0];
    if (typeof first === "number" && results.every(item => item === first)) {
      return first;
    }
    return results;
  }
  const result = walk(geoUnitHierarchy);
  return (typeof result === "number" ? [result] : result) as DistrictsDefinition;
}

@Controller("api/districts")
export class DistrictsController {
  constructor(private readonly regionConfigService: RegionConfigsService) {}

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

    // Build a map from base block ID to its split variants (e.g. "42001..." -> ["42001...-1", "42001...-2"])
    const allBlockIds: Set<string> = new Set(blockIds);
    const mutableSplitBlockMap: Map<string, string[]> = new Map();
    blockIds.forEach(id => {
      const dashIdx = id.indexOf("-");
      if (dashIdx === -1) return;
      const baseId = id.substring(0, dashIdx);
      const mutableExisting = mutableSplitBlockMap.get(baseId);
      if (mutableExisting) {
        mutableExisting.push(id);
      } else {
        mutableSplitBlockMap.set(baseId, [id]);
      }
    });

    // Find unmatched records, expanding split blocks
    const invalidRecords = records.filter((record, i) => {
      if (flaggedRows[i]) return false;
      if (allBlockIds.has(record[0])) return false;
      // Check if this block was split during processing
      if (mutableSplitBlockMap.has(record[0])) return false;
      setFlag(record, i, "BLOCKID", "Invalid block ID");
      return true;
    });

    // This is a heuristic more than an exact detection method, but it seems sufficient from my testing
    if (invalidRecords.length > MAX_IMPORT_ERRORS) {
      return {
        error: `There were ${invalidRecords.length} invalid block IDs for ${regionCode}, ensure the CSV uploaded is for the Census year ${regionConfig?.census}`
      };
    }

    // Build block-to-district mapping, expanding split blocks so all sub-blocks
    // get the same district assignment as their parent
    const mutableBlockToDistricts: { [blockId: string]: number } = {};
    unflaggedRows.forEach(([block, district]) => {
      const d = Number(district);
      if (allBlockIds.has(block)) {
        mutableBlockToDistricts[block] = d;
      }
      const splits = mutableSplitBlockMap.get(block);
      if (splits) {
        splits.forEach(splitId => {
          mutableBlockToDistricts[splitId] = d;
        });
      }
    });
    const districtsDefinition = importCsvToDefinition(
      blockIds,
      geoUnitHierarchy,
      mutableBlockToDistricts
    );

    const maxDistrictId = Object.values(mutableBlockToDistricts).reduce(
      (a, b) => Math.max(a, b),
      0
    );
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
