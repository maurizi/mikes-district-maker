import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { TypeOrmCrudService } from "@dataui/crud-typeorm";
import { Repository, SelectQueryBuilder, DeepPartial } from "typeorm";

import { Project } from "../entities/project.entity";
import { ProjectVisibility } from "../../../../shared/constants";
import { paginate, Pagination, IPaginationOptions } from "nestjs-typeorm-paginate";

type AllProjectsOptions = IPaginationOptions & {
  readonly completed?: boolean;
  readonly region?: string;
  readonly userId?: string;
};

// Convention-based URL: /thumbnails/<id>.png served from the thumbnails S3
// bucket via CloudFront. The ?v=<updatedDt> query busts the client/CDN cache
// whenever the client re-uploads after a save. Projects without an uploaded
// PNG (pre-backfill, or mid-save races) return 404 at the CDN; the UI falls
// back to a broken-image placeholder.
export function thumbnailUrl(project: Pick<Project, "id" | "updatedDt">): string {
  return `/thumbnails/${project.id}.png?v=${project.updatedDt.getTime()}`;
}

function attachThumbnailUrl<T extends Pick<Project, "id" | "updatedDt">>(p: T): T {
  // eslint-disable-next-line functional/immutable-data
  return Object.assign(p, { thumbnailUrl: thumbnailUrl(p) });
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
    return { ...paginated, items: paginated.items.map(attachThumbnailUrl) };
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
    return { ...paginated, items: paginated.items.map(attachThumbnailUrl) };
  }
}
