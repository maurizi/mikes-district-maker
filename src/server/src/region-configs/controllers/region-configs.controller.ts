// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import {
  BadRequestException,
  Controller,
  InternalServerErrorException,
  Logger,
  UseGuards
} from "@nestjs/common";
import {
  Crud,
  CrudController,
  CrudRequest,
  Override,
  ParsedBody,
  ParsedRequest
} from "@dataui/crud";
import { QueryFailedError } from "typeorm";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RegionConfig } from "../entities/region-config.entity";
import { RegionConfigsService } from "../services/region-configs.service";

@Crud({
  model: {
    type: RegionConfig
  },
  query: {
    join: {
      chambers: {
        persist: ["regionConfig"],
        eager: true
      }
    },
    filter: {
      archived: false,
      hidden: false
    }
  },
  routes: {
    only: ["createOneBase", "getManyBase"]
  }
})
@Controller("api/region-configs")
// @ts-ignore
export class RegionConfigsController implements CrudController<RegionConfig> {
  get base(): CrudController<RegionConfig> {
    return this;
  }
  private readonly logger = new Logger(RegionConfigsController.name);
  constructor(public service: RegionConfigsService) {}

  @Override()
  @UseGuards(JwtAuthGuard)
  async createOne(
    @ParsedRequest() req: CrudRequest,
    @ParsedBody() dto: RegionConfig
  ): Promise<RegionConfig> {
    if (!this.base.createOneBase) {
      this.logger.error("Routes misconfigured. Missing `createOneBase` route");
      throw new InternalServerErrorException();
    }
    try {
      return await this.base.createOneBase(req, dto);
    } catch (error) {
      if (error instanceof QueryFailedError) {
        throw new BadRequestException(
          "The following fields are required: name, countryCode, regionCode, s3URI. s3URI must be unique"
        );
      } else {
        this.logger.error(`Error creating region config: ${error}`);
        throw new InternalServerErrorException();
      }
    }
  }
}
