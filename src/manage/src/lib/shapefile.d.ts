declare module "shapefile" {
  export function open(
    shp: string,
    dbf?: string | null,
    options?: Record<string, any>
  ): Promise<{
    read(): Promise<{ done: boolean; value: GeoJSON.Feature }>;
  }>;
}
