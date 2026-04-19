// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Check } from "typeorm";
import { FeatureCollection, MultiPolygon, Point } from "geojson";
import { IReferenceLayer, ReferenceLayerProperties } from "../../../../shared/entities";
import { Project } from "../../projects/entities/project.entity";
import { ReferenceLayerTypes, ReferenceLayerColors } from "../../../../shared/constants";
import { ProjectTemplate } from "../../project-templates/entities/project-template.entity";

export type ReferenceLayerGeojson =
  | FeatureCollection<Point, ReferenceLayerProperties>
  | FeatureCollection<MultiPolygon, ReferenceLayerProperties>;

@Entity()
@Check(`"project_id" IS NOT NULL OR "project_template_id" IS NOT NULL`)
export class ReferenceLayer implements IReferenceLayer {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "character varying" })
  name: string;

  @ManyToOne(() => Project, { nullable: true, eager: true })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @ManyToOne(() => ProjectTemplate, { nullable: true })
  @JoinColumn({ name: "project_template_id" })
  projectTemplate: ProjectTemplate;

  // DSQL has no enum types; stored as varchar with CHECK constraints in the
  // squash migration. TypeORM validates the enum values at the app layer.
  @Column({ type: "varchar", length: 16, default: ReferenceLayerTypes.Point })
  layer_type: ReferenceLayerTypes;

  @Column({ type: "character varying", default: "" })
  label_field: string;

  @Column({
    type: "simple-json",
    name: "layer"
  })
  layer: ReferenceLayerGeojson;

  @Column({ type: "varchar", length: 16, default: ReferenceLayerColors.Green })
  layer_color: ReferenceLayerColors;
}
