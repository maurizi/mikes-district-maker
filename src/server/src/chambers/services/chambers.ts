// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { TypeOrmCrudService } from "@dataui/crud-typeorm";
import { Repository } from "typeorm";

import { Chamber } from "../entities/chamber.entity";

@Injectable()
export class ChambersService extends TypeOrmCrudService<Chamber> {
  constructor(@InjectRepository(Chamber) repo: Repository<Chamber>) {
    super(repo);
  }
}
