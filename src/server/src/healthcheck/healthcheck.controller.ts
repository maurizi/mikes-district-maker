// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Controller, Get } from "@nestjs/common";
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  MemoryHealthIndicator
} from "@nestjs/terminus";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import os from "os";

const S3_CACHE_DIR = process.env.S3_CACHE_DIRECTORY || "/tmp/s3-cache";

// Terminus's TypeOrmHealthIndicator uses a runtime require() that breaks under
// esbuild bundling (it can't find @nestjs/typeorm/typeorm as separate packages
// when they're inlined into the bundle). Inject the DataSource directly and
// run a trivial query instead.
@Controller("healthcheck")
export class HealthcheckController {
  constructor(
    private readonly health: HealthCheckService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator
  ) {}

  private async dbPing(): Promise<HealthIndicatorResult> {
    try {
      await this.dataSource.query("SELECT 1");
      return { database: { status: "up" } };
    } catch (err) {
      return {
        database: {
          status: "down",
          message: err instanceof Error ? err.message : String(err)
        }
      };
    }
  }

  @Get()
  @HealthCheck()
  healthCheck(): Promise<HealthCheckResult> {
    const maxRss = os.totalmem() * 0.95;
    return this.health.check([
      () => this.dbPing(),
      () => this.memory.checkRSS("memory", maxRss),
      () =>
        this.disk.checkStorage("disk", {
          path: S3_CACHE_DIR,
          thresholdPercent: 0.95
        })
    ]);
  }
}
