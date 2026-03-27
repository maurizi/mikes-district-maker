import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  Request,
  UseGuards,
  Header,
  UnauthorizedException,
  HostParam,
  InternalServerErrorException,
  Post,
  Body
} from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";
import stringify from "csv-stringify/lib/sync";

import { IStaticMetadata, OrganizationSlug, ProjectTemplateId } from "../../../../shared/entities";

import { JwtAuthGuard, OptionalJwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { Organization } from "../../organizations/entities/organization.entity";
import { OrganizationsService } from "../../organizations/services/organizations.service";

import { ProjectTemplate } from "../entities/project-template.entity";
import { ProjectTemplatesService } from "../services/project-templates.service";
import { getDemographicLabel } from "../../../../shared/functions";
import { CreateProjectTemplateDto } from "../entities/create-project-template.dto";
import { ProjectsService } from "../../projects/services/projects.service";
import { ReferenceLayersService } from "../../reference-layers/services/reference-layers.service";
import { fetchCachedJson } from "../../common/functions";

const s3 = new S3Client({});

function getMetadataIds(
  metadataMap: { [s3uri: string]: IStaticMetadata },
  prop: "demographics" | "voting"
): readonly string[] {
  return [
    ...new Set(
      Object.values(metadataMap).flatMap(metadata => {
        const data = metadata[prop];
        return data ? data.map(file => file.id) : [];
      })
    )
  ];
}

@Controller("api/project_templates")
export class ProjectTemplatesController {
  constructor(
    private readonly service: ProjectTemplatesService,
    private readonly projectsService: ProjectsService,
    private readonly referenceLayersService: ReferenceLayersService,
    private readonly orgService: OrganizationsService
  ) {}

  async getOrg(organizationSlug: OrganizationSlug): Promise<Organization> {
    const org = await this.orgService.getOrgAndProjectTemplates(organizationSlug);
    if (!org) {
      throw new NotFoundException(`Organization ${organizationSlug} not found`);
    }
    return org;
  }

  async getOrgFeaturedProjects(organizationSlug: OrganizationSlug): Promise<ProjectTemplate[]> {
    const projects = await this.service.findOrgFeaturedProjects(organizationSlug);
    if (!projects) {
      throw new NotFoundException(`Organization ${organizationSlug} not found`);
    }
    return projects;
  }

  @UseGuards(JwtAuthGuard)
  @Get(":slug/")
  async getAllProjects(
    @Param("slug") organizationSlug: OrganizationSlug,
    @Request() req: any
  ): Promise<ProjectTemplate[]> {
    const userId = req.user.id;
    const org = await this.getOrg(organizationSlug);
    const userIsAdmin = org && org.admin.id === userId;
    if (userIsAdmin) {
      return this.service.findAdminOrgProjects(organizationSlug);
    } else {
      throw new BadRequestException(`User is not an admin for organization ${organizationSlug}`);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post(":slug/")
  async createTemplate(
    @Param("slug") organizationSlug: OrganizationSlug,
    @Request() req: any,
    @Body() dto: CreateProjectTemplateDto
  ): Promise<ProjectTemplate> {
    const userId = req.user.id;
    const org = await this.getOrg(organizationSlug);
    const userIsAdmin = org && org.admin.id === userId;
    if (!userIsAdmin) {
      throw new BadRequestException(`User is not an admin for organization ${organizationSlug}`);
    }
    const project = await this.projectsService.findOne({
      where: { id: dto.project.id },
      relations: ["regionConfig", "chamber"]
    });
    if (!project) {
      throw new NotFoundException(`Project ${dto.project.id} not found`);
    }

    const projectTemplate = await this.service.createFromProject(
      dto.description,
      dto.details,
      org,
      project
    );

    const refLayers = await this.referenceLayersService.getProjectReferenceLayers(project.id);
    await Promise.all(
      refLayers.map(refLayer =>
        this.referenceLayersService.create({
          name: refLayer.name,
          label_field: refLayer.label_field,
          layer: refLayer.layer,
          layer_type: refLayer.layer_type,
          projectTemplate
        })
      )
    );

    return projectTemplate;
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get("featured/:slug")
  async getFeaturedProjects(
    @Param("slug") organizationSlug: OrganizationSlug
  ): Promise<ProjectTemplate[]> {
    return this.getOrgFeaturedProjects(organizationSlug);
  }

  @UseGuards(JwtAuthGuard)
  @Get(":slug/export/maps-csv/")
  @Header("Content-Type", "text/csv")
  async exportMapsCsv(
    @Param("slug") slug: OrganizationSlug,
    @Request() req: any,
    @HostParam("host") host: string
  ): Promise<string> {
    const org = await this.getOrg(slug);
    if (org.admin.id !== req.user.id) {
      throw new UnauthorizedException(
        `User does not have admin privileges for organization: ${org.id}`
      );
    }
    const projectRows = await this.service.findAdminOrgProjectsWithDistrictProperties(slug);
    const regionURIs = new Set(projectRows.map(row => row.regionS3URI));

    // Fetch static metadata per region from S3 (no topology needed)
    const metadataMap: { [s3uri: string]: IStaticMetadata } = {};
    for (const uri of regionURIs) {
      try {
        metadataMap[uri] = await fetchCachedJson<IStaticMetadata>(s3, uri, "static-metadata.json");
      } catch {
        // Skip regions where metadata is unavailable
      }
    }

    const projectColumns = [
      "Map creator user-id",
      "Map creator full name",
      "Map creator email",
      "Map name",
      "URL",
      "Created date",
      "Last updated date",
      "Template name",
      "Region name",
      "Chamber name",
      "Submission date",
      "Plan score link"
    ];
    const districtColumns = ["District number", "Contiguity", "Compactness"];
    const demographicsColumns = getMetadataIds(metadataMap, "demographics");
    const votingColumns = getMetadataIds(metadataMap, "voting");

    const formatDate = (date: Date) => date.toISOString().split("T")[0];

    const rows = projectRows.flatMap(row =>
      row.districtProperties.map((districtProps, idx) => {
        if (!metadataMap[row.regionS3URI]) {
          throw new InternalServerErrorException();
        }

        return [
          row.userId,
          row.userName,
          row.userEmail,
          row.mapName,
          `"${host || process.env.CLIENT_URL}/projects/${row.projectId}/"`,
          formatDate(row.createdDt),
          formatDate(row.updatedDt),
          row.templateName,
          row.regionName,
          row?.chamberName || "",
          row.submittedDt ? formatDate(row.submittedDt) : "",
          row.planscoreUrl,
          idx,
          districtProps.contiguity,
          districtProps.compactness
        ]
          .concat(demographicsColumns.map(id => districtProps.demographics[id] || ""))
          .concat(
            votingColumns.map(id => (districtProps.voting ? districtProps?.voting[id] || "" : ""))
          );
      })
    );
    return stringify(rows, {
      header: true,
      columns: projectColumns
        .concat(districtColumns)
        .concat(demographicsColumns.map(getDemographicLabel))
        .concat(votingColumns)
    });
  }

  @UseGuards(JwtAuthGuard)
  @Put(":slug/:id/")
  async archiveTemplate(
    @Param("slug") organizationSlug: OrganizationSlug,
    @Param("id") id: ProjectTemplateId,
    @Request() req: any
  ): Promise<any> {
    const userId = req.user.id;
    const org = await this.getOrg(organizationSlug);
    const userIsAdmin = org && org.admin.id === userId;
    if (!userIsAdmin) {
      throw new BadRequestException(`User is not an admin for organization ${organizationSlug}`);
    }
    const template = await this.service.findOne({ where: { id } });
    if (!template) {
      throw new NotFoundException(`Project ${id} not found`);
    }
    return await this.service.archiveProjectTemplate(id);
  }
}
