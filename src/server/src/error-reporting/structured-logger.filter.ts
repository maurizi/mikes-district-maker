import {
  ArgumentsHost,
  Catch,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import { Request } from "express";
import { BaseExceptionFilter } from "@nestjs/core";

export interface IGetUserAuthInfoRequest extends Request {
  user?: {
    id: number;
  };
}

function isWhitelisted(exception: HttpException) {
  // BadRequestException has its own exception filter already
  return (
    exception instanceof NotFoundException ||
    exception instanceof ServiceUnavailableException ||
    exception instanceof UnauthorizedException
  );
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
  private readonly logger = new Logger("UnhandledException");

  catch(exception: unknown, host: ArgumentsHost): void {
    if (
      (exception instanceof HttpException && !isWhitelisted(exception)) ||
      (exception instanceof Error && !(exception instanceof HttpException))
    ) {
      const ctx = host.switchToHttp();
      const request = ctx.getRequest<IGetUserAuthInfoRequest>();
      const err = exception as Error;
      // Single-line JSON so CloudWatch Logs metric filters can match `{ $.level = "error" }`
      const payload = JSON.stringify({
        level: "error",
        message: err.message,
        stack: err.stack,
        method: request.method,
        path: request.originalUrl ?? request.url,
        userId: request.user?.id,
        ip: parseIp(request)
      });
      this.logger.error(payload);
    }

    // Delegate response formatting to the default global exception filter
    super.catch(exception, host);
  }
}
