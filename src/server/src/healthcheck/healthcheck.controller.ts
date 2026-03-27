import { Controller, Get } from "@nestjs/common";
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator
} from "@nestjs/terminus";
import os from "os";

const S3_CACHE_DIR = process.env.S3_CACHE_DIRECTORY || "/tmp/s3-cache";
// Alert when less than 500MB of disk space remains
const DISK_THRESHOLD_BYTES = 500 * 1024 * 1024;

@Controller("healthcheck")
export class HealthcheckController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator
  ) {}

  @Get()
  @HealthCheck()
  healthCheck(): Promise<HealthCheckResult> {
    const timeout = process.env.TYPEORM_HEALTH_CHECK_TIMEOUT
      ? Number(process.env.TYPEORM_HEALTH_CHECK_TIMEOUT)
      : undefined;
    const maxRss = os.totalmem() * 0.95;
    return this.health.check([
      () => this.db.pingCheck("database", { timeout }),
      () => this.memory.checkRSS("memory", maxRss),
      () => this.disk.checkStorage("disk", {
        path: S3_CACHE_DIR,
        thresholdPercent: 0.95
      })
    ]);
  }
}
