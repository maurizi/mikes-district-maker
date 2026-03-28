import { writeFileSync, openSync, writeSync, closeSync } from "fs";
import { join } from "path";
import { GeometryCollection, GeometryObject, Polygon, MultiPolygon, Topology } from "topojson-specification";

function* walkArcs(geometry: GeometryObject): Generator<number> {
  if (geometry.type === "Polygon") {
    for (const ring of (geometry as Polygon).arcs) {
      for (const arcIdx of ring) {
        yield arcIdx;
      }
    }
  } else if (geometry.type === "MultiPolygon") {
    for (const polygon of (geometry as MultiPolygon).arcs) {
      for (const ring of polygon) {
        for (const arcIdx of ring) {
          yield arcIdx;
        }
      }
    }
  }
}

export function extractAdjacencyData(
  topology: Topology,
  baseGeoLevel: string,
  geoLevelIds: readonly string[],
  outputDir: string
): void {
  const numArcs = topology.arcs.length;
  const collection = topology.objects[baseGeoLevel] as GeometryCollection;
  const geometries = collection.geometries;

  // Build adjacency: for each arc, which block references it forward vs reversed
  // adjacency[arcId * 2]     = block that references arc in forward direction (-1 = exterior)
  // adjacency[arcId * 2 + 1] = block that references arc in reverse direction (-1 = exterior)
  const adjacency = new Int32Array(numArcs * 2).fill(-1);
  for (let blockId = 0; blockId < geometries.length; blockId++) {
    for (const arcIdx of walkArcs(geometries[blockId])) {
      const canonical = arcIdx >= 0 ? arcIdx : ~arcIdx;
      const slot = arcIdx >= 0 ? 0 : 1; // 0 = forward, 1 = reverse
      adjacency[canonical * 2 + slot] = blockId;
    }
  }
  writeFileSync(join(outputDir, "adjacency.bin"), Buffer.from(adjacency.buffer));

  // Pack arc coordinates and build offset index
  const isQuantized = topology.transform !== undefined;
  const bytesPerPoint = isQuantized ? 8 : 16; // 2×Int32 or 2×Float64

  let totalPoints = 0;
  for (const arc of topology.arcs) {
    totalPoints += arc.length;
  }

  const coordsBuf = Buffer.alloc(totalPoints * bytesPerPoint);
  const offsets = new Uint32Array(numArcs + 1);

  let byteOffset = 0;
  for (let i = 0; i < numArcs; i++) {
    offsets[i] = byteOffset;
    const arc = topology.arcs[i];
    for (const point of arc) {
      if (isQuantized) {
        coordsBuf.writeInt32LE(point[0], byteOffset);
        coordsBuf.writeInt32LE(point[1], byteOffset + 4);
        byteOffset += 8;
      } else {
        coordsBuf.writeDoubleLE(point[0], byteOffset);
        coordsBuf.writeDoubleLE(point[1], byteOffset + 8);
        byteOffset += 16;
      }
    }
  }
  offsets[numArcs] = byteOffset;

  writeFileSync(join(outputDir, "arc-coords.bin"), coordsBuf);
  writeFileSync(join(outputDir, "arc-offsets.bin"), Buffer.from(offsets.buffer));
  writeFileSync(
    join(outputDir, "transform.json"),
    JSON.stringify(topology.transform ?? null)
  );

  // Extract block GEOIDs in index order for CSV import/export
  const blockIds = geometries.map(
    (g: GeometryObject<any>) => g.properties?.[baseGeoLevel] as string
  );
  // Stream block IDs to avoid string length limit
  const bidFd = openSync(join(outputDir, "block-ids.json"), "w");
  writeSync(bidFd, "[");
  for (let i = 0; i < blockIds.length; i++) {
    if (i > 0) writeSync(bidFd, ",");
    writeSync(bidFd, JSON.stringify(blockIds[i]));
  }
  writeSync(bidFd, "]");
  closeSync(bidFd);

  // Extract properties per geo level for region lookups (replaces topology properties)
  const geoProperties: Record<string, Record<string, unknown>[]> = {};
  for (const levelId of geoLevelIds) {
    const levelCollection = topology.objects[levelId] as GeometryCollection;
    if (levelCollection) {
      geoProperties[levelId] = levelCollection.geometries.map(
        (g: GeometryObject<any>) => g.properties || {}
      );
    }
  }
  // Stream geo properties to avoid string length limit
  const gpFd = openSync(join(outputDir, "geo-properties.json"), "w");
  writeSync(gpFd, "{");
  const levelIds = Object.keys(geoProperties);
  for (let li = 0; li < levelIds.length; li++) {
    if (li > 0) writeSync(gpFd, ",");
    writeSync(gpFd, JSON.stringify(levelIds[li]) + ":[");
    const items = geoProperties[levelIds[li]];
    for (let i = 0; i < items.length; i++) {
      if (i > 0) writeSync(gpFd, ",");
      writeSync(gpFd, JSON.stringify(items[i]));
    }
    writeSync(gpFd, "]");
  }
  writeSync(gpFd, "}");
  closeSync(gpFd);
}
