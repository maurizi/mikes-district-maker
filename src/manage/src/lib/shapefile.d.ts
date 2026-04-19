// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

declare module "shapefile" {
  export function open(
    shp: string,
    dbf?: string | null,
    options?: Record<string, any>
  ): Promise<{
    read(): Promise<{ done: boolean; value: GeoJSON.Feature }>;
  }>;
}
