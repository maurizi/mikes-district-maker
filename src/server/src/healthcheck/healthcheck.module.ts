// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";

import { HealthcheckController } from "./healthcheck.controller";

@Module({
  controllers: [HealthcheckController],
  imports: [TerminusModule],
  providers: []
})
export class HealthCheckModule {}
