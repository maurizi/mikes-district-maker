import { Args, Command } from "@oclif/core";
import _ from "lodash";
import { S3Client } from "@aws-sdk/client-s3";

import { createDataSource } from "../lib/dbUtils";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { Project } from "../../../server/src/projects/entities/project.entity";
import { User } from "../../../server/src/users/entities/user.entity";
import { GeoUnitHierarchy } from "../../../shared/entities";
import { getObject, s3Options } from "../../../server/src/common/functions";

const s3 = new S3Client({});
const PERCENT_COMPLETE = 0.25;

function countBaseGeounits(hierarchy: GeoUnitHierarchy): number {
  let count = 0;
  for (const item of hierarchy) {
    if (typeof item === "number") {
      count++;
    } else {
      count += countBaseGeounits(item);
    }
  }
  return count;
}

export default class CreateRandomProjects extends Command {
  static description = "creates randomly generated projects for development testing";

  static args = {
    number: Args.string({
      description: "Number of projects to create",
      required: true
    }),
    region: Args.string({
      description: "Region code to create projects for, or 'all'. Defaults to 'all'",
      required: false,
      default: "all"
    })
  };

  async run(): Promise<void> {
    const { args } = await this.parse(CreateRandomProjects);

    const dataSource = await createDataSource();
    const regionConfigRepo = dataSource.getRepository(RegionConfig);
    const projectRepo = dataSource.getRepository(Project);
    const userRepo = dataSource.getRepository(User);

    const regions = await regionConfigRepo.find({
      where: args.region === "all"
        ? { hidden: false, archived: false }
        : { regionCode: args.region, hidden: false, archived: false }
    });

    const user = await userRepo.findOneOrFail({ where: {} });

    this.log(`Generating ${args.number} projects in ${regions.length} region(s)`);
    let completed = 0;
    const total = Number(args.number);

    // Cache hierarchies per region
    const hierarchyCache = new Map<string, GeoUnitHierarchy>();

    for (let i = 0; i < total; i++) {
      const region = _.sample(regions);
      if (!region) {
        this.log(`No regions in database`);
        this.exit(1);
      }

      if (!hierarchyCache.has(region.id)) {
        const resp = await getObject(s3, s3Options(region.s3URI, "geounit-hierarchy.json"));
        const hierarchy: GeoUnitHierarchy = JSON.parse(
          (await resp.Body?.transformToString("utf-8")) ?? "[]"
        );
        hierarchyCache.set(region.id, hierarchy);
      }
      const hierarchy = hierarchyCache.get(region.id)!;
      const defLength = hierarchy.length;

      const numberOfDistricts = _.random(Math.ceil(defLength / 2), defLength);
      const project = new Project();
      const districtsDefinition = Array.from({ length: defLength }, () =>
        _.random(1, numberOfDistricts)
      );
      if (_.random(0, 1, true) >= PERCENT_COMPLETE) {
        const idx = _.random(0, defLength - 1);
        districtsDefinition[idx] = 0;
      }
      const lockedDistricts = new Array(numberOfDistricts).fill(false);
      const numberOfMembers = new Array(numberOfDistricts).fill(1);

      project.name = `Project ${i} ${region.regionCode}`;
      project.numberOfDistricts = numberOfDistricts;
      project.regionConfig = region;
      project.districtsDefinition = districtsDefinition;
      // Districts GeoJSON will be computed client-side on first open
      project.lockedDistricts = lockedDistricts;
      project.numberOfMembers = numberOfMembers;
      project.populationDeviation = 5;
      project.user = user;
      project.regionConfigVersion = region.version;

      // @ts-ignore
      await projectRepo.save(project, { reload: false });
      completed++;
      this.log(`  ${completed}/${total}`);
    }
    this.log(`Projects created`);
    this.exit(0);
  }
}
