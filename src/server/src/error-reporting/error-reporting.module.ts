import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { StructuredLoggerExceptionFilter } from "./structured-logger.filter";

@Module({
  providers: [
    {
      // Global filter that logs unhandled exceptions as structured JSON
      // for ingestion by CloudWatch Logs.
      provide: APP_FILTER,
      useClass: StructuredLoggerExceptionFilter
    }
  ]
})
export class ErrorReportingModule {}
