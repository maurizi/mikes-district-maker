// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Args, Command } from "@oclif/core";
import { readFileSync } from "fs";
import yaml from "js-yaml";
import { type UserId } from "../../../shared/entities";

import { Organization } from "../../../server/src/organizations/entities/organization.entity";
import { ProjectTemplate } from "../../../server/src/project-templates/entities/project-template.entity";
import { User } from "../../../server/src/users/entities/user.entity";

import { createDataSource } from "../lib/dbUtils";

interface TemplateConfig {
  readonly id: string;
  readonly name: string;
  readonly regionConfig: string;
  readonly numberOfDistricts: string;
  readonly numberOfMembers: readonly number[];
  readonly description?: string;
  readonly details?: string;
  readonly contestNextSteps?: string;
  readonly contestActive?: boolean;
}

interface OrganizationConfig {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly admin: UserId;
  readonly logoUrl?: string;
  readonly linkUrl?: string;
  readonly municipality?: string;
  readonly region?: string;
  readonly projectTemplates?: readonly TemplateConfig[];
}

export default class UpdateOrganization extends Command {
  static description = "update or create organization information from a YAML configuration";

  static args = {
    config: Args.string({
      description: "Path to YAML configuration file with organization details",
      required: true
    })
  };

  async run(): Promise<void> {
    const { args } = await this.parse(UpdateOrganization);

    const config = yaml.load(readFileSync(args.config, "utf8"));

    if (!config || typeof config !== "object" || !("name" in config) || !("slug" in config)) {
      this.log(`Invalid organization configuration '${args.config}'`);
      return;
    }

    const organizationDetails = config as OrganizationConfig;

    this.log("Saving organization to database");

    const dataSource = await createDataSource();
    const orgRepo = dataSource.getRepository(Organization);
    const templateRepo = dataSource.getRepository(ProjectTemplate);
    const userRepo = dataSource.getRepository(User);

    const result = await orgRepo.findOne({ where: { slug: organizationDetails.slug } });

    const admin = await userRepo.findOne({ where: { id: organizationDetails.admin } });

    const organization = result || new Organization();
    organization.slug = organizationDetails.slug;
    organization.name = organizationDetails.name;
    organization.description = organizationDetails.description || "";
    organization.logoUrl = organizationDetails.logoUrl || "";
    organization.linkUrl = organizationDetails.linkUrl || "";
    organization.municipality = organizationDetails.municipality || "";
    organization.region = organizationDetails.region || "";
    if (admin) {
      organization.admin = admin;
    }

    // @ts-ignore
    await orgRepo.save(organization);

    for (const config of organizationDetails.projectTemplates || []) {
      const id = config.id;
      const result = await templateRepo.findOne({ where: { id } });
      const template = result || new ProjectTemplate();
      template.organization = organization;
      template.id = id;
      template.name = config.name;
      // @ts-ignore
      template.regionConfig = { id: config.regionConfig };
      template.numberOfDistricts = Number(config.numberOfDistricts);
      template.numberOfMembers = config.numberOfMembers.map(n => Number(n));
      template.description = config.description || "";
      template.details = config.details || "";
      template.contestNextSteps = config.contestNextSteps || "";
      template.contestActive = config.contestActive || false;
      // @ts-ignore
      await templateRepo.save(template);
    }

    this.log("Organization saved to database");
    process.exit(0);
  }
}
