import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { TypeOrmModule } from "@nestjs/typeorm";

import { MailerModule } from "@nestjs-modules/mailer";
import { HandlebarsAdapter } from "@nestjs-modules/mailer/adapters/handlebars.adapter";
import { SES } from "@aws-sdk/client-ses";
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
  mailTransportOptions = {
    SES: { ses: new SES({}), aws: { SES } }
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
        dir: join(__dirname, "..", "..", "templates"),
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
