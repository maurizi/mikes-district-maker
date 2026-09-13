// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { HttpException, HttpStatus } from "@nestjs/common";

// Raised when a third-party API we proxy (PlanScore, etc.) fails or is
// unavailable. Distinct from a plain 5xx because the failure is outside our
// stack: the user gets a clear "try again later", but it shouldn't trip the
// api-errors alarm, which is meant for bugs we can act on. See
// StructuredLoggerExceptionFilter for how the log level is downgraded.
export class UpstreamServiceException extends HttpException {
  readonly service: string;
  readonly cause: string;

  constructor(service: string, cause: unknown) {
    super(
      {
        error: "Bad Gateway",
        message: `${service} is unavailable, please try again later`
      },
      HttpStatus.BAD_GATEWAY
    );
    this.service = service;
    this.cause = cause instanceof Error ? cause.message : String(cause);
  }
}
