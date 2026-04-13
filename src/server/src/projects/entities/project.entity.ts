import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { ProjectVisibility } from "../../../../shared/constants";
import type { DistrictsDefinition, IProject, ThumbnailGeoJSON } from "../../../../shared/entities";
import { RegionConfig } from "../../region-configs/entities/region-config.entity";
import { Chamber } from "../../chambers/entities/chamber.entity";
import { User } from "../../users/entities/user.entity";
import { ProjectTemplate } from "../../project-templates/entities/project-template.entity";
import {
  DEFAULT_POPULATION_DEVIATION,
  DEFAULT_PINNED_METRIC_FIELDS
} from "../../../../shared/constants";

@Entity()
@Index(["updatedDt", "user"])
export class Project implements IProject {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "character varying" })
  name: string;

  @ManyToOne(() => RegionConfig, { nullable: false })
  @JoinColumn({ name: "region_config_id" })
  regionConfig: RegionConfig;

  // The version of Project.regionConfig at the time of last update,
  // used to bust cache for the client-rebuilt district geometry.
  @Column({ type: "timestamp with time zone", name: "region_config_version" })
  regionConfigVersion: Date;

  @ManyToOne(() => Chamber, { nullable: true })
  @JoinColumn({ name: "chamber_id" })
  chamber?: Chamber;

  @ManyToOne(() => ProjectTemplate, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "project_template_id" })
  projectTemplate?: ProjectTemplate;

  @Column({ name: "number_of_districts", type: "integer" })
  numberOfDistricts: number;

  // DSQL stores JSON as text; simple-json serializes transparently.
  @Column({
    type: "simple-json",
    name: "districts_definition",
    nullable: true
  })
  districtsDefinition: DistrictsDefinition;

  // Client-computed, simplified thumbnail geojson used to render project
  // previews on listings. Written by the client on save.
  @Column({
    type: "simple-json",
    name: "thumbnail",
    nullable: true
  })
  thumbnail?: ThumbnailGeoJSON;

  // Whether every geounit is assigned to a district (i.e. the unassigned
  // district is empty). Used by the community-maps listing "completed" filter.
  @Column({ type: "boolean", name: "is_complete", default: false })
  isComplete: boolean;

  @ManyToOne(() => User, { nullable: false, eager: true })
  @JoinColumn({ name: "user_id" })
  user: User;

  @Column({ type: "timestamp with time zone", name: "created_dt", default: () => "NOW()" })
  createdDt: Date;

  @Column({
    type: "timestamp with time zone",
    name: "updated_dt",
    default: () => "NOW()"
  })
  updatedDt: Date;

  @Column({ type: "boolean", default: false, name: "advanced_editing_enabled" })
  advancedEditingEnabled: boolean;

  @Column({
    type: "simple-json",
    name: "locked_districts",
    default: () => "'[]'"
  })
  lockedDistricts: readonly boolean[];

  // DSQL has no enum types; stored as varchar with a CHECK constraint in the
  // squash migration. TypeORM enforces the same values at the app layer.
  @Column({ type: "varchar", length: 16, default: ProjectVisibility.Published })
  visibility: ProjectVisibility;

  @Column({ type: "boolean", default: false })
  archived: boolean;

  @Column({ type: "boolean", default: false, name: "is_featured" })
  isFeatured: boolean;

  @Column({
    type: "double precision",
    name: "population_deviation",
    default: DEFAULT_POPULATION_DEVIATION
  })
  populationDeviation: number;

  @Column({
    type: "simple-json",
    name: "pinned_metric_fields",
    default: () => `'${JSON.stringify(DEFAULT_PINNED_METRIC_FIELDS)}'`
  })
  pinnedMetricFields: string[];

  @Column({
    type: "simple-json",
    name: "number_of_members",
    default: () => "'[]'"
  })
  numberOfMembers: readonly number[];

  // Will either be blank, contain the planscore URL, or the value "error"
  @Column({
    type: "character varying",
    name: "planscore_url",
    default: ""
  })
  planscoreUrl: string;

  @Column({
    type: "timestamp with time zone",
    name: "submitted_dt",
    nullable: true,
    default: null
  })
  submittedDt?: Date;

  // Strips out data that we don't want to have available in the read-only view in the UI
  getReadOnlyView(): Project {
    return { ...this, lockedDistricts: new Array(this.numberOfDistricts).fill(false) };
  }
}
