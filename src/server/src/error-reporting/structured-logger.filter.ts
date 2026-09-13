// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { ArgumentsHost, Catch, HttpException } from "@nestjs/common";
import { Request } from "express";
import { BaseExceptionFilter } from "@nestjs/core";

import { UpstreamServiceException } from "./upstream-service.exception";

export interface IGetUserAuthInfoRequest extends Request {
  user?: {
    id: number;
  };
}

type Severity = "error" | "warn";

// Returns the level to log at, or undefined for exceptions we don't log at all
// (4xx client errors). Only "error" matches the CloudWatch metric filter behind
// the api-errors alarm.
function severity(exception: unknown): Severity | undefined {
  // A third-party API being down isn't a bug on our side and isn't actionable
  // by whoever reads the alarm, so it's logged for visibility but kept below
  // the alarm threshold. Checked before HttpException, which it extends.
  if (exception instanceof UpstreamServiceException) {
    return "warn";
  }
  if (exception instanceof HttpException) {
    return exception.getStatus() >= 500 ? "error" : undefined;
  }
  // Non-HttpException errors (unhandled throws, crashes) are always server errors
  return exception instanceof Error ? "error" : undefined;
}

function parseIp(req: IGetUserAuthInfoRequest): string | undefined {
  if (req.headers["x-forwarded-for"]) {
    if (Array.isArray(req.headers["x-forwarded-for"])) {
      return req.headers["x-forwarded-for"][0];
    } else {
      return req.headers["x-forwarded-for"]?.split(",")[0];
    }
  } else {
    return req.socket?.remoteAddress;
  }
}

@Catch()
export class StructuredLoggerExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const level = severity(exception);
    if (level) {
      const ctx = host.switchToHttp();
      const request = ctx.getRequest<IGetUserAuthInfoRequest>();
      const err = exception as Error;
      // Emit a single root-level JSON object, one per line. Bypasses the
      // NestJS Logger because Logger.error() wraps output in `[Nest] ... ERROR
      // [Context] <msg>` plus ANSI escapes, which CloudWatch Logs metric
      // filters can't parse with `{ $.level = "error" }`. Writing raw to
      // stdout preserves structure so the filter matches.
      const payload = JSON.stringify({
        level,
        message: err.message,
        stack: err.stack,
        method: request.method,
        path: request.originalUrl ?? request.url,
        userId: request.user?.id,
        ip: parseIp(request),
        // Present only on upstream failures: which third party failed and what
        // it said, since the stack above only shows our proxy frame.
        ...(exception instanceof UpstreamServiceException
          ? { service: exception.service, cause: exception.cause }
          : {})
      });
      process.stdout.write(payload + "\n");
    }

    // Delegate response formatting to the default global exception filter
    super.catch(exception, host);
  }
}
