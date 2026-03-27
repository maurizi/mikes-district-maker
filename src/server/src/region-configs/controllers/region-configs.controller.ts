import {
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Param,
  Query,
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
import { S3Client } from "@aws-sdk/client-s3";
import { OptionalJwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { QueryFailedError } from "typeorm";
import { RegionLookupProperties } from "../../../../shared/entities";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RegionConfig } from "../entities/region-config.entity";
import { RegionConfigsService } from "../services/region-configs.service";
import { fetchCachedJson } from "../../common/functions";
import * as _ from "lodash";

const s3 = new S3Client({});

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

  @Get(":regionId/properties/:geounit")
  @UseGuards(OptionalJwtAuthGuard)
  async getRegionProperties(
    @Param("regionId") regionId: string,
    @Param("geounit") geounit: string,
    @Query("fields") fields: string[]
  ): Promise<readonly RegionLookupProperties[]> {
    const regionConfig = await this.service.findOne({ where: { id: regionId } });
    if (!regionConfig) {
      throw new InternalServerErrorException();
    }

    const geoProperties = await fetchCachedJson<Record<string, Record<string, unknown>[]>>(
      s3, regionConfig.s3URI, "geo-properties.json"
    );
    const props = geoProperties[geounit];
    if (!props) {
      throw new InternalServerErrorException();
    }
    return fields ? props.map(f => _.pick(f, fields)) : props;
  }

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
