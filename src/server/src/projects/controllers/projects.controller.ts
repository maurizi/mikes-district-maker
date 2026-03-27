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
  // Not sure why, but eslint thinks these decorators are unused
  /* eslint-disable */
  ParseIntPipe,
  Query,
  /* eslint-enable */
  Body,
  Request,
  Res,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
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
import { Response } from "express";
import FormData from "form-data";
import { convert } from "geojson2shp";
import * as _ from "lodash";
import { spawn, Thread, Worker } from "threads";

import { SimplifyFunctions } from "../../simplify-worker";
import isUUID from "validator/lib/isUUID";
import { Pagination } from "nestjs-typeorm-paginate";

import {
  MakeDistrictsErrors,
  CORE_METRIC_FIELDS,
  PLANSCORE_POLL_MS,
  PLANSCORE_POLL_MAX_TRIES
} from "../../../../shared/constants";
import { S3Client } from "@aws-sdk/client-s3";
import {
  DistrictsDefinition,
  GeoUnitHierarchy,
  IStaticMetadata,
  ProjectId,
  PublicUserProperties,
  UserId
} from "../../../../shared/entities";
import { fetchCachedJson } from "../../common/functions";
import { ProjectVisibility } from "../../../../shared/constants";

import { JwtAuthGuard, OptionalJwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RegionConfig } from "../../region-configs/entities/region-config.entity";
import { User } from "../../users/entities/user.entity";
import { CreateProjectDto } from "../entities/create-project.dto";
import { DistrictsGeoJSON, Project } from "../entities/project.entity";
import { ProjectsService } from "../services/projects.service";
import { OrganizationsService } from "../../organizations/services/organizations.service";

import { RegionConfigsService } from "../../region-configs/services/region-configs.service";
import { UsersService } from "../../users/services/users.service";
import { UpdateProjectDto } from "../entities/update-project.dto";
import { Errors } from "../../../../shared/types";
import axios from "axios";
import { Brackets } from "typeorm";
import { getDemographicsMetricFields, getVotingMetricFields } from "../../../../shared/functions";
import { ProjectTemplatesService } from "../../project-templates/services/project-templates.service";
import { ProjectTemplate } from "../../project-templates/entities/project-template.entity";
import { ReferenceLayersService } from "../../reference-layers/services/reference-layers.service";
import { ChambersService } from "../../chambers/services/chambers";
import { Chamber } from "../../chambers/entities/chamber.entity";
import { ReferenceLayer } from "../../reference-layers/entities/reference-layer.entity";

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
    exclude: ["districts"],
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
    dto: CreateProjectDto,
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
    const project = await this.getProjectWithDistricts(id, userId);
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
      // Overwrite the creator data from the original creator to match the new owner
      districts: project.districts?.metadata?.creator
        ? {
            ...project.districts,
            metadata: { ...project.districts.metadata, creator: { id: user.id, name: user.name } }
          }
        : project.districts
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

  // Helper for obtaining a project for a given project request, throws exception if not found
  async getProjectWithDistricts(id: ProjectId, userId?: UserId): Promise<Project> {
    if (!isUUID(id)) {
      throw new NotFoundException(`Project ${id} is not a valid UUID`);
    }
    // Not using 'getProject' because we need to select the 'districts' column
    // Unauthenticated access is allowed for individual projects if they are
    // visible or published, and not archived.
    const qb = this.service.repository
      .createQueryBuilder("project")
      .leftJoinAndSelect("project.regionConfig", "regionConfig")
      .leftJoinAndSelect("project.projectTemplate", "projectTemplate")
      .leftJoinAndSelect("project.user", "user")
      .leftJoinAndSelect("project.chamber", "chamber")
      .where("project.id = :id", { id })
      .andWhere("project.archived = false");

    if (userId) {
      qb.andWhere(
        new Brackets(inner =>
          inner
            .where("project.visibility = :published", { published: ProjectVisibility.Published })
            .orWhere("project.visibility = :visible", { visible: ProjectVisibility.Visible })
            .orWhere("project.user_id = :userId", { userId })
        )
      );
    } else {
      qb.andWhere(
        new Brackets(inner =>
          inner
            .where("project.visibility = :published", { published: ProjectVisibility.Published })
            .orWhere("project.visibility = :visible", { visible: ProjectVisibility.Visible })
        )
      );
    }

    const project = await qb.getOne();
    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
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

  @Post("convert/shp")
  async convertToShapefile(
    @Body() geojson: DistrictsGeoJSON,
    @Res() response: Response
  ): Promise<void> {
    await this.convertGeoJsonToShapefile(geojson, response);
  }

  private async convertGeoJsonToShapefile(
    geojson: DistrictsGeoJSON,
    response: Response
  ): Promise<void> {
    const formattedGeojson = {
      ...geojson,
      features: geojson.features.map(feature => ({
        ...feature,
        properties: {
          ...feature.properties,
          // Flatten nested demographics & voting objects so they are maintained when converting
          demographics: undefined,
          voting: undefined,
          ...feature.properties.demographics,
          ...feature.properties.voting,
          // The feature ID doesn't seem to make its way over as part of 'convert' natively
          id: feature.id
        }
      }))
    };
    await convert(formattedGeojson, response, { layer: "districts" });
  }

  private async simplifyDistricts(districts: DistrictsGeoJSON): Promise<DistrictsGeoJSON> {
    const worker = await spawn<SimplifyFunctions>(
      new Worker("../../simplify-worker")
    );
    try {
      return await worker.simplifyDistricts(districts);
    } finally {
      await Thread.terminate(worker);
    }
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

    const csvRows: [string, number][] = [];
    function walkCsv(
      defn: DistrictsDefinition | number,
      hier: GeoUnitHierarchy | number
    ) {
      if (typeof hier === "number") {
        csvRows.push([blockIds[hier], typeof defn === "number" ? defn : 0]);
      } else {
        for (let i = 0; i < hier.length; i++) {
          const subDefn = typeof defn === "number" ? defn : defn[i];
          walkCsv(subDefn as DistrictsDefinition | number, hier[i]);
        }
      }
    }
    walkCsv(project.districtsDefinition, hierarchy);

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
    const org = await this.organizationService.findOne({ where: { id: orgId }, relations: ["admin"] });
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
    const project = await this.service.updateOne(req, { submittedDt: new Date(), visibility });
    // Make sure submitted plans have a PlanScore report ready for judges to review
    if (!project.planscoreUrl) {
      this.triggerPlanScoreUpload(req, id);
    }
    return project;
  }

  @UseInterceptors(CrudRequestInterceptor)
  @UseGuards(OptionalJwtAuthGuard)
  @Post(":id/plan-score")
  async sendToPlanScoreAPI(
    @ParsedRequest() req: CrudRequest,
    @Param("id") projectId: ProjectId
  ): Promise<void> {
    // First clear out the existing planscore URL
    await this.service.updateOne(req, { planscoreUrl: "" });
    this.triggerPlanScoreUpload(req, projectId);
  }

  triggerPlanScoreUpload(req: CrudRequest, projectId: ProjectId) {
    const userId = req.parsed.authPersist.userId as string;
    // The body of this function happens in a callback that we *don't* wait for
    // The frontend will poll to find out when this is completed
    void this.getProjectWithDistricts(projectId, userId).then(project => {
      const uploadDistricts = async () => {
        try {
          const planscoreUrl = await this.uploadToPlanScore(project);
          void this.service.updateOne(req, { planscoreUrl });
        } catch (e) {
          this.logger.error(`Error uploading to planscore for project '${projectId}': ${e}`);
          void this.service.updateOne(req, { planscoreUrl: "error" });
        }
      };
      project.districts && uploadDistricts();
    });
  }

  async uploadToPlanScore(project: Project) {
    const PLAN_SCORE_API_TOKEN = process.env.PLAN_SCORE_API_TOKEN || "";
    const uploadResponse = await axios.get("https://api.planscore.org/upload/", {
      headers: {
        Authorization: `Bearer ${PLAN_SCORE_API_TOKEN}`
      }
    });
    const [s3Uri, uploadData]: [string, Record<string, string>] = uploadResponse.data;

    const form = new FormData();
    Object.entries(uploadData).forEach(([key, val]) => {
      form.append(key, val);
    });
    // If we don't remove the unassigned district, PlanScore will never complete processing
    const geojson = { ...project.districts, features: project.districts?.features.slice(1) };
    // Not nearly as easy to do a multi-part form file upload in Node as it is in the browser
    //  - We need to use a module to emulate the browser native FormData
    //  - axios doesn't integrate well with it, so we need to connect headers & length manually
    form.append("file", Buffer.from(JSON.stringify(geojson)), {
      contentType: "application/json",
      filename: `${project.name}.geojson`
    });
    const s3Response = await axios.post(s3Uri, form, {
      headers: {
        ...form.getHeaders(),
        "Content-Length": `${form.getLengthSync()}`
      },
      // API docs say to expect 302, but in practice I've seen 303, checking for either to be safe
      validateStatus: (status: number) => status === 302 || status === 303,
      maxRedirects: 0
    });
    const callbackLocation = s3Response.headers["location"];
    const apiResponse = await axios.post(
      callbackLocation,
      {
        description: project.name
      },
      {
        headers: {
          Authorization: `Bearer ${PLAN_SCORE_API_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    const { index_url: indexUrl, plan_url: planscoreUrl } = apiResponse.data;
    this.logger.debug(`PlanScore submitted, polling ${indexUrl}`);
    if (typeof indexUrl !== "string" || typeof planscoreUrl !== "string") {
      throw new Error("Unexpected response from PlanScore API");
    }
    await this.pollPlanScoreProgress(indexUrl);
    return planscoreUrl;
  }

  async pollPlanScoreProgress(indexUrl: string, numTries = 1) {
    return new Promise((resolve, reject) => {
      axios
        .get(indexUrl)
        .then((apiResponse: any) => {
          apiResponse.data.status
            ? resolve(void 0)
            : numTries >= PLANSCORE_POLL_MAX_TRIES
            ? reject(new Error("Exceeded maximum number of retries"))
            : setTimeout(
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
    return this.getProject(req, id);
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
    const userId = req.parsed.authPersist.userId as string;
    const existingProject = await this.getProjectWithDistricts(id, userId);
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

    // If client sent computed districts, simplify for mini-map views
    if (dto.districts) {
      const simplified = await this.simplifyDistricts(dto.districts);
      Object.assign(data, { simplifiedDistricts: simplified });
    }

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

    const chamber = dto.chamber?.id
      ? await this.chambersService.findOne({ where: { id: dto.chamber?.id } })
      : undefined;

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

    const data = this.formatCreateProjectDto(
      formdata,
      districtsDefLength,
      regionConfig,
      req
    );

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
