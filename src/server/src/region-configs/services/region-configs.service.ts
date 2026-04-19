// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { TypeOrmCrudService } from "@dataui/crud-typeorm";
import { Repository } from "typeorm";

import { RegionConfig } from "../entities/region-config.entity";

@Injectable()
export class RegionConfigsService extends TypeOrmCrudService<RegionConfig> {
  constructor(@InjectRepository(RegionConfig) public repo: Repository<RegionConfig>) {
    super(repo);
  }
}
