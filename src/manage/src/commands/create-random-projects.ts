import { Args, Command } from "@oclif/core";
import _ from "lodash";

import { createDataSource, dataSourceOptions } from "../lib/dbUtils";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { Project } from "../../../server/src/projects/entities/project.entity";
import { TopologyService } from "../../../server/src/districts/services/topology.service";
import { WorkerPoolService } from "../../../server/src/districts/services/worker-pool.service";
import { User } from "../../../server/src/users/entities/user.entity";

const PERCENT_COMPLETE = 0.25;

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

    const topologyService = new TopologyService(regionConfigRepo, new WorkerPoolService());
    await topologyService.loadLayers();

    const layers = Object.values(topologyService.layers() || {});
    this.log(`Downloading topology for ${layers.length} layers`);
    await Promise.all(layers);

    this.log(`Generating ${args.number} projects in ${regions.length} region(s)`);
    let completed = 0;
    const total = Number(args.number);

    for (let i = 0; i < Number(args.number); i++) {
      const region = _.sample(regions);
      if (!region) {
        this.log(`No regions in database`);
        this.exit(1);
      }
      const geoCollection = await topologyService.get(region);
      if (!geoCollection || !("merge" in geoCollection)) {
        this.log(`No active topology for region`);
        this.exit(1);
      }

      const numCounties = geoCollection.districtsDefLength;
      const numberOfDistricts = _.random(Math.ceil(numCounties / 2), numCounties);
      const project = new Project();
      const districtsDefinition = Array.from({ length: numCounties }, () =>
        _.random(1, numberOfDistricts)
      );
      // Set a percentage of projects to be incomplete by assigning a random block to the unassigned district
      if (_.random(0, 1, true) >= PERCENT_COMPLETE) {
        const countyIdx = _.random(0, numCounties - 1);
        districtsDefinition[countyIdx] = 0;
      }
      const lockedDistricts = new Array(numberOfDistricts).fill(false);
      const numberOfMembers = new Array(numberOfDistricts).fill(1);
      const { districts, simplifiedDistricts } = {
        ...(await geoCollection.merge({
          districtsDefinition,
          numberOfDistricts,
          user,
          regionConfig: region
        }))
      };
      if (!districts) {
        this.log(`Could not generate geojson`);
        this.exit(1);
      }
      project.name = `Project ${i} ${region.regionCode}`;
      project.numberOfDistricts = numberOfDistricts;
      project.regionConfig = region;
      project.districtsDefinition = districtsDefinition;
      project.districts = districts;
      project.simplifiedDistricts = simplifiedDistricts;
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
