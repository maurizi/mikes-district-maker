// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import {
  BadRequestException,
  Controller,
  Get,
  Header,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  ParseIntPipe,
  Query,
  Body,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  Crud,
  CrudAuth,
  CrudController,
  CrudRequest,
  CrudRequestInterceptor,
  Override,
  ParsedBody,
  ParsedRequest
} from "@dataui/crud";
import stringify from "csv-stringify/lib/sync";
import * as _ from "lodash";

import isUUID from "validator/lib/isUUID";
import { Pagination } from "nestjs-typeorm-paginate";

import {
  CORE_METRIC_FIELDS,
  PLANSCORE_POLL_MS,
  PLANSCORE_POLL_MAX_TRIES
} from "../../../../shared/constants";
import { S3Client } from "@aws-sdk/client-s3";
import type {
  DistrictProperties,
  DistrictsDefinition,
  GeoUnitHierarchy,
  IStaticMetadata,
  ProjectId,
  PublicUserProperties
} from "../../../../shared/entities";
import { fetchCachedJson } from "../../common/functions";
import { ProjectVisibility } from "../../../../shared/constants";

import { JwtAuthGuard, OptionalJwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RegionConfig } from "../../region-configs/entities/region-config.entity";
import { User } from "../../users/entities/user.entity";
import { CreateProjectDto } from "../entities/create-project.dto";
import { Project } from "../entities/project.entity";
import { ProjectsService, thumbnailUrl } from "../services/projects.service";
import { OrganizationsService } from "../../organizations/services/organizations.service";

import { RegionConfigsService } from "../../region-configs/services/region-configs.service";
import { UsersService } from "../../users/services/users.service";
import { UpdateProjectDto } from "../entities/update-project.dto";
import { Errors } from "../../../../shared/types";
import axios from "axios";
import {
  getDemographicsMetricFields,
  getVotingMetricFields,
  isBlankDistrictsDefinition
} from "../../../../shared/functions";
import { ProjectTemplatesService } from "../../project-templates/services/project-templates.service";
import { ProjectTemplate } from "../../project-templates/entities/project-template.entity";
import { ReferenceLayersService } from "../../reference-layers/services/reference-layers.service";
import { ChambersService } from "../../chambers/services/chambers";
import { ReferenceLayer } from "../../reference-layers/entities/reference-layer.entity";

const THUMBNAIL_UPLOAD_URL_EXPIRES_SECONDS = 5 * 60;

export function thumbnailS3Key(projectId: ProjectId): string {
  return `${projectId}.png`;
}

function validateNumberOfMembers(
  dto: CreateProjectDto | UpdateProjectDto,
  numberOfDistricts: number
): void {
  if (dto.numberOfMembers && numberOfDistricts !== dto.numberOfMembers.length) {
    throw new BadRequestException({
      error: "Bad Request",
      message: { numberOfMembers: [`Length of array does not match "numberOfDistricts"`] }
    } as Errors<UpdateProjectDto>);
  }
  if (dto.numberOfMembers && dto.numberOfMembers.some(num => num === 0)) {
    throw new BadRequestException({
      error: "Bad Request",
      message: { numberOfMembers: [`Districts cannot have 0 representatives`] }
    } as Errors<UpdateProjectDto>);
  }
  if (dto.numberOfMembers && dto.numberOfMembers.some(num => num === null || Number.isNaN(num))) {
    throw new BadRequestException({
      error: "Bad Request",
      message: { numberOfMembers: [`Number of representatives is required for every district`] }
    } as Errors<UpdateProjectDto>);
  }
}

@Crud({
  model: {
    type: Project
  },
  params: {
    id: {
      type: "string",
      primary: true,
      field: "id"
    }
  },
  query: {
    join: {
      chamber: {
        eager: true
      },
      projectTemplate: {
        exclude: ["districtsDefinition"],
        eager: true
      },
      "projectTemplate.organization": {
        eager: true
      },
      "projectTemplate.organization.admin": {
        alias: "org_admin",
        eager: false
      },
      "projectTemplate.regionConfig": {
        alias: "template_region_config",
        eager: true
      },
      regionConfig: {
        eager: true
      },
      user: {
        allow: ["id", "name"] as PublicUserProperties[],
        alias: "project_user",
        required: true,
        eager: true
      }
    }
  },
  routes: {
    only: ["createOneBase", "getManyBase", "getOneBase", "updateOneBase"]
  },
  dto: {
    update: UpdateProjectDto
  }
})
@CrudAuth({
  filter: (req: any) => {
    const user = req.user as User;
    const endpoint = req.route.path.split("/").reverse()[0];
    // Restrict access to organization projects if using toggleFeatured endpoint
    if (endpoint === "toggleFeatured") {
      return {
        "projectTemplate.organization.admin": user.id
      };
      // Filter to user's projects for all other update requests, except for the duplicate endpoint.
    } else if (req.method !== "GET" && endpoint !== "duplicate") {
      return {
        "project_user.id": user ? user.id : undefined
      };
    } else {
      // Unauthenticated access is allowed for individual projects if they are
      // visible or published, and not archived.
      const publicallyVisible = [
        { visibility: ProjectVisibility.Published },
        { visibility: ProjectVisibility.Visible }
      ];
      const visibleFilter = user
        ? [
            // User created project
            { "project_user.id": user.id },
            // Or it's public
            ...publicallyVisible
          ]
        : publicallyVisible;
      return {
        $and: [
          {
            $or: visibleFilter
          },
          { archived: false }
        ]
      };
    }
  },
  persist: (req: any) => {
    const user = req.user as User;
    return {
      userId: user ? user.id : undefined
    };
  }
})
@Controller("api/projects")
// @ts-ignore
export class ProjectsController implements CrudController<Project> {
  get base(): CrudController<Project> {
    return this;
  }

  private readonly logger = new Logger(ProjectsController.name);
  private readonly s3 = new S3Client({});
  constructor(
    public service: ProjectsService,
    public templateService: ProjectTemplatesService,
    private readonly usersService: UsersService,
    private readonly organizationService: OrganizationsService,
    private readonly regionConfigService: RegionConfigsService,
    private readonly referenceLayerService: ReferenceLayersService,
    private readonly chambersService: ChambersService
  ) {}

  private formatCreateProjectDto(
    // The duplicate flow feeds a Project entity through this helper, so
    // districtProperties may arrive as null rather than absent.
    dto: Omit<CreateProjectDto, "districtProperties"> & {
      readonly districtProperties?: readonly DistrictProperties[] | null;
    },
    districtsLength: number,
    regionConfig: RegionConfig,
    req: CrudRequest
  ) {
    // Districts definition is optional. Use it if supplied, otherwise use all-unassigned.
    const districtsDefinition = dto.districtsDefinition || new Array(districtsLength).fill(0);
    const lockedDistricts = new Array(dto.numberOfDistricts).fill(false);
    const numberOfMembers = dto.numberOfMembers || new Array(dto.numberOfDistricts).fill(1);
    return {
      ...dto,
      districtsDefinition,
      lockedDistricts,
      numberOfMembers,
      user: req.parsed.authPersist.userId,
      regionConfigVersion: regionConfig.version
    };
  }

  private async copyReferenceLayers(project: Project, refLayers: ReferenceLayer[]): Promise<void> {
    // We need to wait for reference layers to be copied, but then we don't
    // actually need to do anything with the result
    await Promise.all(
      refLayers.map(refLayer =>
        this.referenceLayerService.create({
          name: refLayer.name,
          label_field: refLayer.label_field,
          layer: refLayer.layer,
          layer_type: refLayer.layer_type,
          project
        })
      )
    );
  }

  @UseGuards(JwtAuthGuard)
  @UseInterceptors(CrudRequestInterceptor)
  @Post(":id/duplicate")
  async duplicate(@ParsedRequest() req: CrudRequest, @Param("id") id: ProjectId): Promise<Project> {
    const userId =
      typeof req.parsed.authPersist.userId === "string" ? req.parsed.authPersist.userId : undefined;
    const project = await this.getProject(req, id);
    const user = await this.usersService.findOne({ where: { id: userId } });
    if (!user) {
      throw new InternalServerErrorException(`User not found for authenticated user id ${userId}`);
    }

    const dto = {
      ...project,
      name: `Copy of ${project.name}`,
      // Set any fields we don't want duplicated to be undefined
      id: undefined,
      user: undefined,
      createdDt: undefined,
      updatedDt: undefined,
      submittedDt: undefined,
      isFeatured: undefined,
      planscoreUrl: ""
    };

    try {
      const projectCopy = await this.service.save(
        this.formatCreateProjectDto(dto, dto.districtsDefinition.length, project.regionConfig, req)
      );
      await this.copyReferenceLayers(
        projectCopy,
        await this.referenceLayerService.getProjectReferenceLayers(id)
      );
      return projectCopy;
    } catch (error) {
      this.logger.error(`Error creating project: ${error}`);
      throw new InternalServerErrorException();
    }
  }

  // Helper for obtaining a project for a given project request, throws exception if not found
  async getProject(req: CrudRequest, projectId: ProjectId): Promise<Project> {
    if (!this.base.getOneBase) {
      this.logger.error("Routes misconfigured. Missing `getOneBase` route");
      throw new InternalServerErrorException();
    }
    if (!isUUID(projectId)) {
      throw new NotFoundException(`Project ${projectId} is not a valid UUID`);
    }
    const project = await this.base.getOneBase(req).then(project => {
      return project.user.id === req.parsed.authPersist.userId
        ? project
        : project.getReadOnlyView();
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return project;
  }

  // Helper to fetch lightweight S3 data for a region (no topology needed)
  private async fetchRegionS3Data(
    regionConfig: RegionConfig
  ): Promise<{ staticMetadata: IStaticMetadata; hierarchy: GeoUnitHierarchy }> {
    const [staticMetadata, hierarchy] = await Promise.all([
      fetchCachedJson<IStaticMetadata>(this.s3, regionConfig.s3URI, "static-metadata.json"),
      fetchCachedJson<GeoUnitHierarchy>(this.s3, regionConfig.s3URI, "geounit-hierarchy.json")
    ]);
    return { staticMetadata, hierarchy };
  }

  // Compute districts definition length from hierarchy
  private computeDistrictsDefLength(hierarchy: GeoUnitHierarchy): number {
    return hierarchy.length;
  }

  @UseInterceptors(CrudRequestInterceptor)
  @UseGuards(JwtAuthGuard)
  @Post(":id/thumbnail-upload-url")
  async createThumbnailUploadUrl(
    @ParsedRequest() req: CrudRequest,
    @Param("id") projectId: ProjectId
  ): Promise<{ uploadUrl: string }> {
    // Client rendered a new PNG and needs to PUT it to S3. We re-verify
    // ownership here (getProject via crud respects the auth filter) before
    // handing out a signed URL.
    const project = await this.getProject(req, projectId);
    const bucket = process.env.THUMBNAILS_BUCKET;
    if (!bucket) {
      this.logger.error("THUMBNAILS_BUCKET env var not set");
      throw new InternalServerErrorException();
    }
    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: thumbnailS3Key(project.id),
        ContentType: "image/png",
        CacheControl: "public, max-age=3600"
      }),
      { expiresIn: THUMBNAIL_UPLOAD_URL_EXPIRES_SECONDS }
    );
    return { uploadUrl };
  }

  @UseInterceptors(CrudRequestInterceptor)
  @UseGuards(OptionalJwtAuthGuard)
  @Get(":id/export/csv")
  @Header("Content-Type", "text/csv")
  async exportCsv(
    @ParsedRequest() req: CrudRequest,
    @Param("id") projectId: ProjectId
  ): Promise<string> {
    const project = await this.getProject(req, projectId);
    const regionConfig = project.regionConfig;

    const [blockIds, hierarchy, metadata] = await Promise.all([
      fetchCachedJson<string[]>(this.s3, regionConfig.s3URI, "block-ids.json"),
      fetchCachedJson<GeoUnitHierarchy>(this.s3, regionConfig.s3URI, "geounit-hierarchy.json"),
      fetchCachedJson<IStaticMetadata>(this.s3, regionConfig.s3URI, "static-metadata.json")
    ]);
    const baseGeoLevel = metadata.geoLevelHierarchy[0].id;

    function walkCsv(
      defn: DistrictsDefinition | number,
      hier: GeoUnitHierarchy | number
    ): (readonly [string, number])[] {
      if (typeof hier === "number") {
        return [[blockIds[hier], typeof defn === "number" ? defn : 0]];
      }
      return hier.flatMap((h, i) => {
        const subDefn = typeof defn === "number" ? defn : defn[i];
        return walkCsv(subDefn as DistrictsDefinition | number, h);
      });
    }
    const csvRows = walkCsv(project.districtsDefinition, hierarchy);

    return stringify(csvRows, {
      header: true,
      columns: [`${baseGeoLevel.toUpperCase()}ID`, "DISTRICT"]
    });
  }

  @UseInterceptors(CrudRequestInterceptor)
  @UseGuards(JwtAuthGuard)
  @Post(":id/toggleFeatured")
  async setProjectAsFeatured(
    @ParsedRequest() req: CrudRequest,
    @Param("id") projectId: ProjectId,
    @Body() projectFeatured: { isFeatured: boolean }
  ): Promise<Project> {
    const project = await this.getProject(req, projectId);
    if (!project.projectTemplate) {
      throw new NotFoundException("Project is not connected to an organization's template");
    }
    const orgId = project.projectTemplate.organization.id;
    if (!orgId) {
      throw new NotFoundException("Project is not connected to an organization");
    }
    const userId = req.parsed.authPersist.userId || null;
    const org = await this.organizationService.findOne({
      where: { id: orgId },
      relations: ["admin"]
    });
    const user = await this.usersService.findOne({ where: { id: userId } });
    if (!user || !org) {
      throw new NotFoundException(`Unable to find user: ${userId}`);
    }
    if (!org.admin) {
      throw new NotFoundException(`Organization ${orgId} does not have an admin`);
    }
    if (org.admin.id !== userId) {
      throw new NotFoundException(`User does not have admin privileges for organization: ${orgId}`);
    }

    // eslint-disable-next-line
    project.isFeatured = projectFeatured.isFeatured;
    await this.service.save(project);
    return project;
  }

  @UseInterceptors(CrudRequestInterceptor)
  @Override()
  @UseGuards(JwtAuthGuard)
  @Post(":id/submit")
  async submitProject(@Param("id") id: ProjectId, @ParsedRequest() req: CrudRequest) {
    const existingProject = await this.getProject(req, id);
    if (!existingProject.projectTemplate?.contestActive) {
      throw new NotFoundException("Project is not connected to a template with an active contest");
    }
    // Submitted maps can't be private
    const visibility =
      existingProject.visibility !== ProjectVisibility.Private
        ? existingProject.visibility
        : ProjectVisibility.Visible;
    // The client is responsible for kicking off the PlanScore upload after
    // submit if planscoreUrl is still empty — it holds the districts geojson.
    return this.service.updateOne(req, { submittedDt: new Date(), visibility });
  }

  // Thin proxy for PlanScore step 1 (GET /upload). The bearer token is held
  // server-side; the response [s3Uri, formFields] is forwarded to the browser
  // which then POSTs the geometry directly to PlanScore's S3 bucket.
  @UseGuards(JwtAuthGuard)
  @Get(":id/plan-score/upload-credentials")
  async planScoreUploadCredentials(
    @Param("id") projectId: ProjectId
  ): Promise<[string, Record<string, string>]> {
    if (!isUUID(projectId)) {
      throw new NotFoundException(`Project ${projectId} is not a valid UUID`);
    }
    const uploadResponse = await axios.get<[string, Record<string, string>]>(
      "https://api.planscore.org/upload/",
      {
        headers: { Authorization: `Bearer ${process.env.PLAN_SCORE_API_TOKEN || ""}` }
      }
    );
    return uploadResponse.data;
  }

  // Thin proxy for PlanScore step 3 (POST to the callback location returned by
  // the S3 upload). Kicks off server-side polling and persists the final URL
  // on the Project once PlanScore finishes; the browser polls /projects/:id
  // just like before to discover completion.
  @UseInterceptors(CrudRequestInterceptor)
  @UseGuards(JwtAuthGuard)
  @Post(":id/plan-score/finalize")
  async planScoreFinalize(
    @ParsedRequest() req: CrudRequest,
    @Param("id") projectId: ProjectId,
    @Body() body: { readonly callbackLocation: string; readonly description?: string }
  ): Promise<void> {
    if (!isUUID(projectId)) {
      throw new NotFoundException(`Project ${projectId} is not a valid UUID`);
    }
    await this.service.updateOne(req, { planscoreUrl: "" });
    void this.finalizeAndPoll(req, projectId, body.callbackLocation, body.description || "");
  }

  private async finalizeAndPoll(
    req: CrudRequest,
    projectId: ProjectId,
    callbackLocation: string,
    description: string
  ) {
    try {
      const apiResponse = await axios.post(
        callbackLocation,
        { description },
        {
          headers: {
            Authorization: `Bearer ${process.env.PLAN_SCORE_API_TOKEN || ""}`,
            "Content-Type": "application/json"
          }
        }
      );
      const { index_url: indexUrl, plan_url: planscoreUrl } = apiResponse.data;
      if (typeof indexUrl !== "string" || typeof planscoreUrl !== "string") {
        throw new Error("Unexpected response from PlanScore API");
      }
      this.logger.debug(`PlanScore submitted, polling ${indexUrl}`);
      await this.pollPlanScoreProgress(indexUrl);
      void this.service.updateOne(req, { planscoreUrl });
    } catch (e) {
      this.logger.error(`Error uploading to planscore for project '${projectId}': ${e}`);
      void this.service.updateOne(req, { planscoreUrl: "error" });
    }
  }

  async pollPlanScoreProgress(indexUrl: string, numTries = 1) {
    return new Promise((resolve, reject) => {
      axios
        .get(indexUrl)
        .then((apiResponse: any) => {
          if (apiResponse.data.status) {
            resolve(void 0);
            return;
          }
          if (numTries >= PLANSCORE_POLL_MAX_TRIES) {
            reject(new Error("Exceeded maximum number of retries"));
            return;
          }
          setTimeout(
            () => resolve(this.pollPlanScoreProgress(indexUrl, numTries + 1)),
            PLANSCORE_POLL_MS
          );
        })
        .catch((e: any) => reject(e));
    });
  }

  // Overriden to add OptionalJwtAuthGuard, and possibly return a read-only view
  @Override()
  @UseGuards(OptionalJwtAuthGuard)
  async getOne(@Param("id") id: ProjectId, @ParsedRequest() req: CrudRequest): Promise<Project> {
    const project = await this.getProject(req, id);
    const isBlank = isBlankDistrictsDefinition(project.districtsDefinition);
    // eslint-disable-next-line functional/immutable-data
    return Object.assign(project, { thumbnailUrl: thumbnailUrl(project, isBlank) });
  }

  // Overriden to add JwtAuthGuard and support pagination
  @Override()
  @UseGuards(JwtAuthGuard)
  getMany(
    @ParsedRequest() req: CrudRequest,
    @Query("page", ParseIntPipe) page = 1,
    @Query("limit", ParseIntPipe) limit = 10
  ): Promise<Pagination<Project>> {
    const userId = req.parsed.authPersist.userId as string;
    return this.service.findAllUserProjectsPaginated(userId, { page, limit });
  }

  @Override()
  @UseGuards(JwtAuthGuard)
  async updateOne(
    @Param("id") id: ProjectId,
    @ParsedRequest() req: CrudRequest,
    @ParsedBody() dto: UpdateProjectDto
  ) {
    // Start off with some validations that can't be handled easily at the DTO layer
    const existingProject = await this.getProject(req, id);
    if (dto.lockedDistricts && existingProject.numberOfDistricts !== dto.lockedDistricts.length) {
      throw new BadRequestException({
        error: "Bad Request",
        message: { lockedDistricts: [`Length of array does not match "numberOfDistricts"`] }
      } as Errors<UpdateProjectDto>);
    }
    validateNumberOfMembers(dto, existingProject.numberOfDistricts);

    if (dto.pinnedMetricFields) {
      const { staticMetadata } = await this.fetchRegionS3Data(existingProject.regionConfig);
      const allowedDemographicFields = getDemographicsMetricFields(staticMetadata).map(
        ([, field]) => field
      );
      const allowedVotingFields: readonly string[] =
        getVotingMetricFields(staticMetadata).map(([, field]) => field) || [];
      if (
        dto.pinnedMetricFields.some(
          field =>
            !(
              CORE_METRIC_FIELDS.includes(field) ||
              allowedDemographicFields.includes(field) ||
              allowedVotingFields.includes(field)
            )
        )
      ) {
        throw new BadRequestException({
          error: "Bad Request",
          message: { pinnedMetricFields: [`Field not allowed in "pinnedMetricFields"`] }
        } as Errors<UpdateProjectDto>);
      }
    }

    const dataWithDefinitions =
      existingProject &&
      dto.districtsDefinition &&
      !_.isEqual(dto.districtsDefinition, existingProject.districtsDefinition)
        ? {
            ...dto,
            regionConfigVersion: existingProject.regionConfig.version,
            // PlanScore link is no longer valid when districts are changed
            planscoreUrl: ""
          }
        : dto;

    // Only change updatedDt field when whitelisted fields have changed
    const whitelistedFields: ReadonlyArray<keyof UpdateProjectDto> = [
      "districtsDefinition",
      "name"
    ];
    const fields = whitelistedFields.filter(field => field in dto);
    const data = _.isEqual(_.pick(dataWithDefinitions, fields), _.pick(existingProject, fields))
      ? { ...dataWithDefinitions }
      : { ...dataWithDefinitions, updatedDt: new Date() };

    return this.service.updateOne(req, {
      ...data,
      isFeatured: dto.visibility === ProjectVisibility.Private ? false : existingProject?.isFeatured
    });
  }

  @Override()
  @UseGuards(JwtAuthGuard)
  async createOne(
    @ParsedRequest() req: CrudRequest,
    @ParsedBody() dto: CreateProjectDto
  ): Promise<Project> {
    if (dto.numberOfDistricts) {
      validateNumberOfMembers(dto, dto.numberOfDistricts);
    }

    const template = dto.projectTemplate
      ? await this.templateService.findOne({
          where: { id: dto.projectTemplate.id, isActive: true, regionConfig: { archived: false } },
          relations: ["regionConfig", "referenceLayers", "chamber"]
        })
      : undefined;
    if (dto.projectTemplate && !template) {
      throw new NotFoundException(`Project template for id '${dto.projectTemplate?.id}' not found`);
    }

    const userId = req.parsed.authPersist.userId as string;
    const user = await this.usersService.findOne({ where: { id: userId } });
    if (!user) {
      throw new InternalServerErrorException(`User not found for authenticated user id ${userId}`);
    }

    const regionConfig = dto.regionConfig
      ? await this.regionConfigService.findOne({ where: { id: dto.regionConfig.id } })
      : template
        ? template.regionConfig
        : undefined;
    if (!regionConfig) {
      throw new NotFoundException(`Unable to find region config: ${dto.regionConfig?.id}`);
    }

    const { hierarchy } = await this.fetchRegionS3Data(regionConfig);
    const districtsDefLength = this.computeDistrictsDefLength(hierarchy);

    // Pulls out the fields on ProjectTemplate common to it & Project
    const templateFields = ({
      name,
      regionConfig,
      chamber,
      numberOfDistricts,
      numberOfMembers,
      populationDeviation,
      pinnedMetricFields,
      districtsDefinition
    }: ProjectTemplate) => ({
      name,
      regionConfig,
      chamber,
      numberOfDistricts,
      numberOfMembers,
      populationDeviation,
      pinnedMetricFields,
      districtsDefinition
    });
    // most template fields take precedence, but districtsDefinition should preferentially use the
    // DTO data, to support imports w/ templates
    const formdata = template
      ? {
          ...dto,
          ...templateFields(template),
          districtsDefinition: dto.districtsDefinition || template.districtsDefinition
        }
      : dto;
    if (!formdata.numberOfDistricts) {
      // The validation in the DTO should prevent this
      throw new InternalServerErrorException();
    }

    const data = this.formatCreateProjectDto(formdata, districtsDefLength, regionConfig, req);

    try {
      // Districts GeoJSON is computed client-side on load
      const project = await this.service.createOne(req, data);
      // Copy any reference layers associated with the template to the project
      if (template) {
        await this.copyReferenceLayers(project, template.referenceLayers);
      }
      return project;
    } catch (error) {
      this.logger.error(`Error creating project: ${error}`);
      throw new InternalServerErrorException();
    }
  }
}
