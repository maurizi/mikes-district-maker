import { Module } from "@nestjs/common";

import { RegionConfigsModule } from "../region-configs/region-configs.module";
import { DistrictsController } from "./controllers/districts.controller";

@Module({
  controllers: [DistrictsController],
  imports: [RegionConfigsModule],
  providers: [],
  exports: []
})
export class DistrictsModule {}
