import { Command, Flags } from "@oclif/core";

import { createDataSource } from "../lib/dbUtils";
import { Project } from "../../../server/src/projects/entities/project.entity";
import { ProjectVisibility } from "../../../shared/constants";

export default class SortProjectsAlpha extends Command {
  static description =
    "Re-stamp updated_dt so published projects sort alphabetically (A first) on the community maps page (which sorts by updated_dt DESC)";

  static flags = {
    "dry-run": Flags.boolean({
      description: "Print the new ordering without writing",
      default: false
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SortProjectsAlpha);
    const dryRun = flags["dry-run"];

    const dataSource = await createDataSource();
    const projectRepo = dataSource.getRepository(Project);

    // Fetch all published (visible) projects, sorted alphabetically by name.
    const projects = await projectRepo.find({
      where: { visibility: ProjectVisibility.Published },
      order: { name: "ASC" }
    });

    this.log(`Found ${projects.length} published project(s)`);
    if (projects.length === 0) {
      await dataSource.destroy();
      return;
    }

    // Community maps sorts by updated_dt DESC, so alphabetically-first projects
    // need the LATEST timestamps. We space them 1 second apart starting from now,
    // with the last alphabetical project getting "now" and the first getting
    // "now + (N-1) seconds".
    const now = Date.now();

    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      // First alphabetically (i=0) gets the highest timestamp
      const newDt = new Date(now + (projects.length - 1 - i) * 1000);

      if (dryRun) {
        this.log(`  ${i + 1}. ${project.name}  →  ${newDt.toISOString()}`);
      } else {
        await projectRepo.update(project.id, { updatedDt: newDt });
        this.log(`  ${i + 1}. ${project.name}  →  ${newDt.toISOString()}`);
      }
    }

    this.log(`\n=== ${dryRun ? "Dry run complete" : "Done"} ===`);
    await dataSource.destroy();
  }
}
