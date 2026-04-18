import { Controller, Get, Header, HttpStatus, Param, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import isUUID from "validator/lib/isUUID";

import { ProjectVisibility } from "../../../../shared/constants";
import type { DistrictProperties, ProjectId } from "../../../../shared/entities";
import { ProjectsService } from "../services/projects.service";

// For each district, decide which party won the most recent presidential year
// present in its voting record. Also returns the 4-digit year used (the
// latest one seen across districts — in practice they'll all agree since a
// region's voting files are the same for every district). Returns null when
// no district has usable voting data — callers fall back to a generic
// description.
function partisanBreakdown(
  properties: readonly DistrictProperties[] | null | undefined
): { dem: number; rep: number; tossup: number; year: number } | null {
  if (!properties || properties.length === 0) return null;
  let dem = 0;
  let rep = 0;
  let tossup = 0;
  let decided = 0;
  let latestYy = "";
  // Skip index 0 (unassigned district, not an electable district).
  for (let i = 1; i < properties.length; i++) {
    const voting = properties[i]?.voting;
    if (!voting) continue;
    const years: string[] = [];
    for (const key of Object.keys(voting)) {
      const m = key.match(/^democrat(\d{2})$/);
      if (m && `republican${m[1]}` in voting) years.push(m[1]);
    }
    if (years.length === 0) continue;
    const latest = years.sort()[years.length - 1];
    if (latest > latestYy) latestYy = latest;
    const d = (voting as Record<string, number>)[`democrat${latest}`];
    const r = (voting as Record<string, number>)[`republican${latest}`];
    decided++;
    if (d > r) dem++;
    else if (r > d) rep++;
    else tossup++;
  }
  if (decided === 0 || !latestYy) return null;
  return { dem, rep, tossup, year: 2000 + parseInt(latestYy, 10) };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SITE_NAME = "Mike's District Maker";

function renderOgHtml(fields: {
  readonly title: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly canonicalUrl: string;
  readonly spaUrl: string;
}): string {
  const { title, description, imageUrl, canonicalUrl, spaUrl } = fields;
  // Belt-and-suspenders: if a human lands here by accident, send them to the
  // SPA. Bots parse the <meta> tags before executing the refresh.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(imageUrl)}">
<meta http-equiv="refresh" content="0; url=${escapeHtml(spaUrl)}">
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
</head>
<body></body>
</html>`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function buildBaseUrl(req: Request): string {
  // Respect CloudFront / proxy headers so the generated URLs use the public
  // hostname, not the Lambda internal URL.
  const forwardedHost =
    typeof req.headers["x-forwarded-host"] === "string"
      ? req.headers["x-forwarded-host"]
      : undefined;
  const host = forwardedHost || req.headers.host || "mikesdistrictmaker.com";
  const forwardedProto =
    typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"]
      : undefined;
  const proto = forwardedProto || "https";
  return `${proto}://${host}`;
}

@Controller("og/projects")
export class OgController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get(":id")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "public, max-age=300")
  async getProjectOg(
    @Param("id") id: ProjectId,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const baseUrl = buildBaseUrl(req);
    const spaUrl = `${baseUrl}/projects/${encodeURIComponent(id)}`;
    if (!isUUID(id)) {
      res.status(HttpStatus.NOT_FOUND);
      return renderOgHtml({
        title: "Mike's District Maker",
        description:
          "Mike's District Maker is free, open source software for drawing electoral district maps.",
        imageUrl: `${baseUrl}/favicon.ico`,
        canonicalUrl: spaUrl,
        spaUrl
      });
    }
    const project = await this.projectsService.repository
      .createQueryBuilder("project")
      .leftJoinAndSelect("project.regionConfig", "regionConfig")
      .leftJoinAndSelect("project.user", "user")
      .where("project.id = :id", { id })
      .getOne();

    const isPublic =
      project !== null && !project.archived && project.visibility !== ProjectVisibility.Private;

    if (!project || !isPublic) {
      res.status(HttpStatus.NOT_FOUND);
      return renderOgHtml({
        title: "Mike's District Maker",
        description:
          "Mike's District Maker is free, open source software for drawing electoral district maps.",
        imageUrl: `${baseUrl}/favicon.ico`,
        canonicalUrl: spaUrl,
        spaUrl
      });
    }

    // Target 50–60 chars for og:title. Site name is emitted separately via
    // og:site_name so the title itself stays focused on the project.
    const title = truncate(project.name, 60);
    const creator = project.user?.name?.trim();
    const breakdown = partisanBreakdown(project.districtProperties);
    const parts: string[] = [];
    if (breakdown) {
      parts.push(`${breakdown.dem} D`, `${breakdown.rep} R`);
      if (breakdown.tossup > 0) parts.push(`${breakdown.tossup} tied`);
    }
    // Target 110–160 chars for og:description.
    const byLine = creator ? ` by ${creator}` : "";
    const description = breakdown
      ? `Proposed ${project.regionConfig.name} map${byLine}: ${parts.join(" / ")} across ${project.numberOfDistricts} districts, based on the ${breakdown.year} presidential vote. Explore and share at ${SITE_NAME}.`
      : `Proposed ${project.regionConfig.name} map${byLine} with ${project.numberOfDistricts} districts. Explore, edit, and share at ${SITE_NAME}.`;
    const imageUrl = `${baseUrl}/thumbnails/${project.id}.png?v=${project.updatedDt.getTime()}`;
    return renderOgHtml({
      title,
      description,
      imageUrl,
      canonicalUrl: spaUrl,
      spaUrl
    });
  }
}
