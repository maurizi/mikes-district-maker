import "reflect-metadata";
import { BadRequestException, ClassSerializerInterceptor, ValidationPipe } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { BadRequestExceptionFilter } from "./common/bad-request-exception.filter";
import { DEBUG } from "../../shared/constants";
import * as bodyParser from "body-parser";
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: DEBUG ? ["debug", "verbose", "log", "warn", "error"] : ["log", "warn", "error"]
  });
  app.useGlobalPipes(
    new ValidationPipe({
      exceptionFactory: errors => new BadRequestException(errors),
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true
    })
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new BadRequestExceptionFilter());
  // Lambda has a ~6MB sync-invoke payload ceiling; after base64 and event
  // wrapper overhead the practical raw request body limit is ~5MB. A Texas-
  // scale districtsDefinition (~1MB) plus a 3MB thumbnail plus metadata fits
  // inside that. The previous 25MB limit was from when districts GeoJSON
  // bodies existed; that column is gone and those endpoints no longer take
  // full GeoJSON in the request body.
  app.use(bodyParser.json({ limit: "5mb" }));
  app.use(bodyParser.urlencoded({ limit: "5mb", extended: true }));

  // Save the output of 'listen' to a variable, which is a Node http.Server
  const server = await app.listen(3005);

  // Ensure all inactive connections are terminated by the ALB, by setting this
  // a few seconds higher than the ALB idle timeout
  server.keepAliveTimeout = 65000; // eslint-disable-line functional/immutable-data

  // Ensure the headersTimeout is set higher than the keepAliveTimeout due to
  // this nodejs regression bug: https://github.com/nodejs/node/issues/27363
  server.headersTimeout = 66000; // eslint-disable-line functional/immutable-data
}
bootstrap(); // eslint-disable-line @typescript-eslint/no-floating-promises
