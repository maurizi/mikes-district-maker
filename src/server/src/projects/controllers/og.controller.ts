// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Controller, Get, Header, HttpStatus, Param, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import isUUID from "validator/lib/isUUID";

import { ProjectVisibility } from "../../../../shared/constants";
import type { DemographicCounts, DistrictProperties, ProjectId } from "../../../../shared/entities";
import { isBlankDistrictsDefinition } from "../../../../shared/functions";
import { ProjectsService, thumbnailUrl } from "../services/projects.service";

const SITE_NAME = "Mike's District Maker";
const GENERIC_DESCRIPTION =
  "Mike's District Maker is free, open source software for drawing electoral district maps.";

type Winner = "dem" | "rep" | "tossup";
type DistrictResult = { readonly year: string; readonly winner: Winner };
type Breakdown = {
  readonly dem: number;
  readonly rep: number;
  readonly tossup: number;
  readonly year: number;
};

type OgFields = {
  readonly title: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly canonicalUrl: string;
  readonly spaUrl: string;
};

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => HTML_ESCAPES[c]);

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";

const headerString = (req: Request, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

// Respect CloudFront / proxy headers so the generated URLs use the public
// hostname, not the Lambda internal URL.
const buildBaseUrl = (req: Request): string => {
  const host =
    headerString(req, "x-forwarded-host") || req.headers.host || "mikesdistrictmaker.com";
  const proto = headerString(req, "x-forwarded-proto") || "https";
  return `${proto}://${host}`;
};

const districtResult = (voting: DemographicCounts): DistrictResult | null => {
  const years = Object.keys(voting)
    .map(k => /^democrat(\d{2})$/.exec(k)?.[1])
    .filter((yy): yy is string => !!yy && `republican${yy}` in voting)
    .sort();
  if (years.length === 0) return null;
  const latest = years[years.length - 1];
  const d = voting[`democrat${latest}`];
  const r = voting[`republican${latest}`];
  return { year: latest, winner: d > r ? "dem" : r > d ? "rep" : "tossup" };
};

// For each district, decide which party won the most recent presidential year
// present in its voting record. Also returns the 4-digit year used (the
// latest one seen across districts — in practice they'll all agree since a
// region's voting files are the same for every district). Returns null when
// no district has usable voting data — callers fall back to a generic
// description.
const partisanBreakdown = (
  properties: readonly DistrictProperties[] | null | undefined
): Breakdown | null => {
  if (!properties || properties.length <= 1) return null;
  const results = properties
    // Skip index 0 (unassigned district, not an electable district).
    .slice(1)
    .map(p => p?.voting)
    .filter((v): v is DemographicCounts => !!v)
    .map(districtResult)
    .filter((r): r is DistrictResult => r !== null);
  if (results.length === 0) return null;
  const counts = results.reduce((acc, { winner }) => ({ ...acc, [winner]: acc[winner] + 1 }), {
    dem: 0,
    rep: 0,
    tossup: 0
  } as Record<Winner, number>);
  const latestYy = results.reduce((acc, { year }) => (year > acc ? year : acc), "");
  return { ...counts, year: 2000 + parseInt(latestYy, 10) };
};

// Belt-and-suspenders: if a human lands here by accident, send them to the
// SPA. Bots parse the <meta> tags before executing the refresh.
//
// imageUrl points at the 1200x630 og variant so Bluesky/Facebook/etc don't
// crop a square preview down to their 1.91:1 link-card slot — that crop
// chops the top and bottom off square-ish states (FL, IA, IL).
const renderOgHtml = ({ title, description, imageUrl, canonicalUrl, spaUrl }: OgFields): string =>
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
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

const fallbackFields = (baseUrl: string, spaUrl: string): OgFields => ({
  title: SITE_NAME,
  description: GENERIC_DESCRIPTION,
  imageUrl: `${baseUrl}/favicon.ico`,
  canonicalUrl: spaUrl,
  spaUrl
});

type ProjectForDescription = {
  readonly regionConfig: { readonly name: string };
  readonly numberOfDistricts: number;
  readonly user?: { readonly name?: string } | null;
  readonly districtProperties?: readonly DistrictProperties[] | null;
};

const describeProject = (project: ProjectForDescription): string => {
  const byLine = project.user?.name?.trim() ? ` by ${project.user.name.trim()}` : "";
  const breakdown = partisanBreakdown(project.districtProperties);
  if (!breakdown) {
    return `Proposed ${project.regionConfig.name} map${byLine} with ${project.numberOfDistricts} districts. Explore, edit, and share at ${SITE_NAME}.`;
  }
  const parts = [
    `${breakdown.dem} D`,
    `${breakdown.rep} R`,
    ...(breakdown.tossup > 0 ? [`${breakdown.tossup} tied`] : [])
  ];
  return `Proposed ${project.regionConfig.name} map${byLine}: ${parts.join(" / ")} across ${project.numberOfDistricts} districts, based on the ${breakdown.year} presidential vote. Explore and share at ${SITE_NAME}.`;
};

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

    const project = isUUID(id)
      ? await this.projectsService.repository
          .createQueryBuilder("project")
          .leftJoinAndSelect("project.regionConfig", "regionConfig")
          .leftJoinAndSelect("project.user", "user")
          .where("project.id = :id", { id })
          .getOne()
      : null;

    const isPublic =
      project !== null && !project.archived && project.visibility !== ProjectVisibility.Private;

    if (!project || !isPublic) {
      res.status(HttpStatus.NOT_FOUND);
      return renderOgHtml(fallbackFields(baseUrl, spaUrl));
    }

    const isBlank = isBlankDistrictsDefinition(project.districtsDefinition);
    return renderOgHtml({
      // Target 50–60 chars for og:title. Site name is emitted separately via
      // og:site_name so the title itself stays focused on the project.
      title: truncate(project.name, 60),
      // Target 110–160 chars for og:description.
      description: describeProject(project),
      imageUrl: `${baseUrl}${thumbnailUrl(project, isBlank, "og")}`,
      canonicalUrl: spaUrl,
      spaUrl
    });
  }
}
