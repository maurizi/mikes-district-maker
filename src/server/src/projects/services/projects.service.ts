import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { TypeOrmCrudService } from "@dataui/crud-typeorm";
import { Repository, SelectQueryBuilder, DeepPartial } from "typeorm";

import { Project } from "../entities/project.entity";
import { ProjectVisibility } from "../../../../shared/constants";
import { type ProjectId } from "../../../../shared/entities";
import { paginate, Pagination, IPaginationOptions } from "nestjs-typeorm-paginate";

type AllProjectsOptions = IPaginationOptions & {
  readonly completed?: boolean;
  readonly region?: string;
  readonly userId?: string;
};

type ProjectForThumbnail = Pick<Project, "id" | "updatedDt" | "regionConfigId">;

// Convention-based URL: /thumbnails/<id>.png served from the thumbnails S3
// bucket via CloudFront. The ?v=<updatedDt> query busts the client/CDN cache
// whenever the client re-uploads after a save. For projects that have never
// been touched (districtsDefinition is all zeros) we point at a per-region
// blank PNG instead, avoiding an S3 write per brand-new project for a
// thumbnail that would look identical for every blank project in that region.
//
// isBlank is passed in rather than derived here: the definition is stored as
// text and can be multiple MB per row for block-level assignments, so list
// views check blankness via a lightweight second SQL query against just the
// paginated IDs instead of pulling the full JSON into the main select.
export function thumbnailUrl(project: ProjectForThumbnail, isBlank: boolean): string {
  if (isBlank) {
    return `/thumbnails/region-${project.regionConfigId}.png`;
  }
  return `/thumbnails/${project.id}.png?v=${project.updatedDt.getTime()}`;
}

function attachThumbnailUrl<T extends ProjectForThumbnail>(p: T, isBlank: boolean): T {
  // eslint-disable-next-line functional/immutable-data
  return Object.assign(p, { thumbnailUrl: thumbnailUrl(p, isBlank) });
}

@Injectable()
export class ProjectsService extends TypeOrmCrudService<Project> {
  constructor(@InjectRepository(Project) repo: Repository<Project>) {
    super(repo);
  }

  get repository(): Repository<Project> {
    return this.repo;
  }

  save(project: DeepPartial<Project>): Promise<Project> {
    // @ts-ignore
    return this.repo.save(project);
  }

  getProjectsBase(): SelectQueryBuilder<Project> {
    return this.repo
      .createQueryBuilder("project")
      .innerJoin("project.regionConfig", "regionConfig")
      .innerJoin("project.user", "user")
      .leftJoin("project.chamber", "chamber")
      .select([
        "project.id",
        "project.name",
        "project.numberOfDistricts",
        "project.updatedDt",
        "project.createdDt",
        "project.submittedDt",
        "project.regionConfigId",
        "chamber.name",
        "regionConfig.name",
        "regionConfig.id",
        "regionConfig.archived",
        "regionConfig.s3URI",
        "user.id",
        "user.name"
      ])
      .orderBy("project.updatedDt", "DESC");
  }

  async findAllPublishedProjectsPaginated(
    options: AllProjectsOptions
  ): Promise<Pagination<Project>> {
    const builder = this.getProjectsBase()
      .andWhere("project.visibility = :published", {
        published: ProjectVisibility.Published
      })
      .andWhere("project.archived = FALSE");
    const builderWithFilter = options.completed
      ? builder.andWhere("project.isComplete = :isComplete", { isComplete: true })
      : builder;
    const builderWithRegion = options.region
      ? builderWithFilter.andWhere("regionConfig.regionCode = :region", { region: options.region })
      : builderWithFilter;

    const paginated = await paginate<Project>(builderWithRegion, options);
    const blankIds = await this.findBlankProjectIds(paginated.items.map(p => p.id));
    return {
      ...paginated,
      items: paginated.items.map(p => attachThumbnailUrl(p, blankIds.has(p.id)))
    };
  }

  async findAllUserProjectsPaginated(
    userId: string,
    options: AllProjectsOptions
  ): Promise<Pagination<Project>> {
    const builder = this.getProjectsBase().andWhere(
      "project.archived = FALSE AND user.id = :userId",
      { userId }
    );

    const paginated = await paginate<Project>(builder, options);
    const blankIds = await this.findBlankProjectIds(paginated.items.map(p => p.id));
    return {
      ...paginated,
      items: paginated.items.map(p => attachThumbnailUrl(p, blankIds.has(p.id)))
    };
  }

  // Returns the subset of the given project IDs whose districts_definition has
  // no non-zero digits — i.e. nothing has been drawn yet. The definition is
  // stored as text, so a POSIX regex for any digit 1-9 is a cheap way to
  // check blankness without pulling the full JSON payload back in the primary
  // list query. Intended only for small batches (a single page of results).
  async findBlankProjectIds(ids: readonly ProjectId[]): Promise<Set<ProjectId>> {
    if (ids.length === 0) return new Set();
    const rows = await this.repo
      .createQueryBuilder("project")
      .select("project.id", "id")
      .where("project.id IN (:...ids)", { ids })
      .andWhere("project.districts_definition !~ '[1-9]'")
      .getRawMany<{ readonly id: ProjectId }>();
    return new Set(rows.map(r => r.id));
  }
}
