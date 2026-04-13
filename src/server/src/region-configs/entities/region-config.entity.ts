import {
  Column,
  Entity,
  JoinColumn,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique
} from "typeorm";
import { IRegionConfig } from "../../../../shared/entities";
import { Chamber } from "../../chambers/entities/chamber.entity";
import { ProjectTemplate } from "../../project-templates/entities/project-template.entity";
import { CensusDate } from "../../../../shared/constants";

@Entity()
// The old partial unique index on (country_code, region_code) WHERE hidden <>
// TRUE was dropped because DSQL has no partial indexes, and a plain unique
// index would block the "retire and recreate with same code" pattern that
// archived regions depend on. The four-column Unique below still prevents
// exact duplicates (same name+country+region+version).
@Unique(["name", "countryCode", "regionCode", "version"])
export class RegionConfig implements IRegionConfig {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "character varying" })
  name: string;

  @Column({ type: "character varying", name: "country_code" })
  countryCode: string;

  @Column({ type: "character varying", name: "region_code" })
  regionCode: string;

  @OneToMany(() => ProjectTemplate, projectTemplate => projectTemplate.regionConfig)
  projectTemplates: ProjectTemplate[];

  @OneToMany(() => Chamber, chamber => chamber.regionConfig)
  @JoinColumn({ name: "chamber_id" })
  chambers: readonly Chamber[];

  @Column({ type: "character varying", name: "s3_uri", unique: true })
  s3URI: string;

  @Column({ type: "timestamp with time zone", default: () => "NOW()" })
  version: Date;

  // Hidden regions have data loaded and can be used to edit projects,
  // but do not appear in the list of regions when creating a new project
  @Column({ type: "boolean", default: false })
  hidden: boolean;

  // Archived regions are hidden, and also do not have data loaded and so their projects cannot be edited
  @Column({ type: "boolean", default: false })
  archived: boolean;

  // DSQL has no enum types; stored as varchar with a CHECK constraint in the
  // squash migration. TypeORM validates CensusDate values at the app layer.
  @Column({ type: "varchar", length: 4, default: CensusDate.Census2020 })
  census: CensusDate;
}
