// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { TypeOrmModule } from "@nestjs/typeorm";

import { MailerModule } from "@nestjs-modules/mailer";
import { HandlebarsAdapter } from "@nestjs-modules/mailer/adapters/handlebars.adapter";
import { SES, SendRawEmailCommand } from "@aws-sdk/client-ses";
import * as SESTransport from "nodemailer/lib/ses-transport";
import * as StreamTransport from "nodemailer/lib/stream-transport";

import { DEBUG } from "../../shared/constants";
import { dataSourceOptions } from "./data-source";
import { AuthModule } from "./auth/auth.module";
import { HealthCheckModule } from "./healthcheck/healthcheck.module";
import { OrganizationsModule } from "./organizations/organizations.module";
import { ProjectsModule } from "./projects/projects.module";
import { ProjectTemplatesModule } from "./project-templates/project-templates.module";
import { RegionConfigsModule } from "./region-configs/region-configs.module";
import { ReferenceLayersModule } from "./reference-layers/reference-layers.module";
import { ErrorReportingModule } from "./error-reporting/error-reporting.module";
import { UsersModule } from "./users/users.module";

import { join } from "path";

let mailTransportOptions: StreamTransport.Options | SESTransport.Options;
// In development the email service is a no-op that only logs
if (DEBUG) {
  mailTransportOptions = {
    streamTransport: true,
    buffer: true,
    newline: "unix"
  };
} else {
  // nodemailer's SES transport expects different shapes for SDK v2 vs v3.
  // For v3 it expects `aws: { SendRawEmailCommand }` and internally calls
  // `ses.send(new SendRawEmailCommand(...))`. Passing the `SES` class (v2
  // pattern) makes it fall back to `.sendRawEmail(...).promise()` which
  // doesn't exist in v3.
  mailTransportOptions = {
    SES: { ses: new SES({}), aws: { SendRawEmailCommand } }
  } as unknown as SESTransport.Options;
}

@Module({
  imports: [
    MailerModule.forRoot({
      transport: mailTransportOptions,
      defaults: {
        from: '"nest-modules" <modules@nestjs.com>'
      },
      template: {
        dir: join(__dirname, "templates"),
        adapter: new HandlebarsAdapter(),
        options: {
          strict: true
        }
      }
    }),
    TypeOrmModule.forRoot(dataSourceOptions),
    TerminusModule,
    ErrorReportingModule,
    AuthModule,
    HealthCheckModule,
    OrganizationsModule,
    ProjectsModule,
    ProjectTemplatesModule,
    ReferenceLayersModule,
    RegionConfigsModule,
    UsersModule
  ]
})
export class AppModule {}
