// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

/* eslint-disable @typescript-eslint/no-empty-object-type */
import { Args, Command, Flags, ux } from "@oclif/core";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync
} from "fs";
import { tmpdir } from "os";
import { pipeline } from "stream/promises";
import { type Feature, type FeatureCollection, type MultiPolygon, type Polygon } from "geojson";
import { parse } from "JSONStream";
import { JsonStreamStringify } from "json-stream-stringify";
import groupBy from "lodash/groupBy";
import mapValues from "lodash/mapValues";
import { join } from "path";
import { feature as topo2feature, mergeArcs, quantize } from "topojson-client";
import { topology } from "topojson-server";
import { planarTriangleArea, presimplify, simplify } from "topojson-simplify";
import {
  type GeometryCollection,
  type GeometryObject,
  type Objects,
  type Topology
} from "topojson-specification";

import {
  type GeoLevelInfo,
  type GeoUnitDefinition,
  type HierarchyDefinition,
  type IStaticFile,
  type IStaticMetadata,
  type DemographicsGroup
} from "../../../shared/entities";
import { writeContainer } from "cloud-topo/encode";
import { CtopoClient, makeRangeFetcher } from "cloud-topo";
import { geojsonPolygonLabels, tileJoin, tippecanoe } from "../lib/cmd";
import { abbrev } from "../lib/voting-data";
import _ from "lodash";

// Shoelace area of a linear ring in its own coordinate units (deg² here).
// Used to identify degenerate interior rings that topojson's mergeArcs leaves
// behind when two adjacent blocks' shared-edge arcs weren't deduped — the
// "hole" is actually a collinear spike with near-zero signed area.
function ringArea(ring: readonly (readonly number[])[]): number {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

// Drop interior rings below `minAreaDeg2`. At Alabama's latitude (~33°N),
// 1e-12 deg² ≈ 10 m² — well below real precinct enclaves, well above the
// degenerate spikes (~0 m²) we see on dissolved county boundaries.
function stripDegenerateHoles<G extends Polygon | MultiPolygon>(
  geom: G,
  minAreaDeg2: number
): { geom: G; dropped: number } {
  let dropped = 0;
  const filterPoly = (poly: readonly (readonly number[])[][]): number[][][] => {
    const out: number[][][] = [poly[0] as number[][]];
    for (let i = 1; i < poly.length; i++) {
      if (ringArea(poly[i]) >= minAreaDeg2) out.push(poly[i] as number[][]);
      else dropped++;
    }
    return out;
  };
  if (geom.type === "Polygon") {
    return { geom: { ...geom, coordinates: filterPoly(geom.coordinates) } as G, dropped };
  }
  const polys = (geom as MultiPolygon).coordinates.map(filterPoly);
  return { geom: { ...geom, coordinates: polys } as G, dropped };
}

// Takes a comma-separated list of items, optionally as a pair separated by a ':'
// and returns an array
function splitPairs(input: string): readonly [string, string][] {
  return input.length === 0
    ? []
    : input
        .split(",")
        .map(item =>
          item.includes(":") ? (item.split(":", 2) as [string, string]) : [item, item]
        );
}

export default class ProcessGeojson extends Command {
  static description = `process GeoJSON into desired output files

Note: this can be a very memory-intensive operation,
depending on the size of the GeoJSON. If you receive
an error related to memory usage, you can increase
the Node.js memory limit by setting the following
environment variable (as large as needed):

NODE_OPTIONS="--max-old-space-size=14336"

Relatedly, set the -b flag for large GeoJSON files
that need to be streamed. This is slower, so only use
it when necessary (file sizes ~500MB+, due to Node.js
max string length of ~512MB).
`;

  static flags = {
    big: Flags.boolean({
      char: "b",
      description: "Use this for big GeoJSON files (~1GB+) that need to be streamed"
    }),

    levels: Flags.string({
      char: "l",
      description: `Comma-separated geolevel hierarchy: smallest to largest
      To use a different name for the layer ID from the GeoJSON property, separate values by ':'
      e.g. -l geoid:block,blockgroupuuid:blockgroup,county
      `,
      default: "block,blockgroup,county"
    }),

    levelMinZoom: Flags.string({
      char: "n",
      description: "Comma-separated minimum zoom level per geolevel, must match # of levels",
      default: "8,0,0"
    }),

    levelMaxZoom: Flags.string({
      char: "x",
      description: "Comma-separated maximum zoom level per geolevel, must match # of levels",
      default: "g,g,g"
    }),

    demographics: Flags.string({
      char: "d",
      description: `Comma-separated group of census demographics to select and aggregate
      To use a different name for the property from the GeoJSON property, separate values by ':'
      e.g. -d pop:population,wht:white,blk:black

      The first value in the group will be used as population, and the remaining values will be displayed
      as a percentage of that population.

      To create multiple groups, use the -d option once per group.
      e.g. -d population,white,black,asian,hispanic,other -d "VAP,VAP White, VAP Black, VAP Asian, VAP Hispanic, VAP Other" 
      `,
      default: ["population,white,black,asian,hispanic,other"],
      multiple: true
    }),

    voting: Flags.string({
      char: "v",
      description: `Comma-separated election data to select and aggregate
      To use a different name for the layer property from the GeoJSON property, separate values by ':'
      e.g. -v voterep:republican,votedem:democrat,voteoth:other
      `,
      default: ""
    }),

    simplification: Flags.string({
      char: "s",
      description: "Topojson simplification amount (minWeight)",
      default: "0.0000000025"
    }),

    quantization: Flags.string({
      char: "q",
      description: "Topojson quantization transform, 0 to skip",
      default: "1e5"
    }),

    outputDir: Flags.string({
      char: "o",
      description: "Directory to output files",
      default: "./"
    }),

    inputS3Dir: Flags.string({
      char: "u",
      description: "S3 directory for the previous run if we will be updating in-place",
      default: ""
    }),

    filterPrefix: Flags.string({
      char: "f",
      description: "Filter to only base geounits containing the specified prefix",
      default: ""
    }),

    maximumTileBytes: Flags.string({
      char: "t",
      description: "Maximum tile size in bytes for tippecanoe (default 750000)",
      default: "750000"
    }),

    skipTiles: Flags.boolean({
      description:
        "Skip vector-tile generation (tippecanoe + tileJoin). Use when iterating on the .ctopo encoder — basemap tiles are unaffected by encoder changes and re-rendering them takes minutes per state."
    }),

    writeBenchTopology: Flags.boolean({
      description:
        "Also write topo-bench.json next to topo.json — same TopoJSON structure but unfiltered (every demographic + voting field plus the parent-index sections that are populated post addGeoLevelIndices). Used as the input for the .ctopo encoder benchmark sweep so we can re-encode under different presets without re-running process-geojson. Multi-GB on big states; only set when benching."
    })
  };

  static args = {
    file: Args.string({ required: true })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProcessGeojson);

    if (!existsSync(args.file)) {
      this.error(`file ${args.file} does not exist, exiting`);
    }

    if (!existsSync(flags.outputDir)) {
      this.error(`output directory ${flags.outputDir} does not exist, exiting`);
    }

    const geoLevels = splitPairs(flags.levels);
    const geoLevelIds = geoLevels.map(([, id]) => id);
    const voting = splitPairs(flags.voting);
    const votingIds = voting.map(([, id]) => id);
    const minZooms = flags.levelMinZoom.split(",");
    const maxZooms = flags.levelMaxZoom.split(",");
    const demographics = splitPairs(flags.demographics.join(","));
    const demographicIds = demographics.map(([, id]) => id);
    const simplification = parseFloat(flags.simplification);
    const quantization = parseFloat(flags.quantization);
    const maximumTileBytes = parseInt(flags.maximumTileBytes) || 750000;

    if (geoLevels.length !== minZooms.length || geoLevels.length !== maxZooms.length) {
      this.error(
        "'levels' 'levelMinZoom' and 'levelMaxZoom' must all have the same length, exiting"
      );
    }

    ux.action.start(`Reading base GeoJSON: ${args.file}`);
    let baseGeoJson = await (flags.big
      ? this.readBigGeoJson(args.file)
      : this.readSmallGeoJson(args.file));
    ux.action.stop();

    const numFeatures = baseGeoJson.features.length;
    this.log(`GeoJSON contains ${numFeatures.toString()} features`);
    if (numFeatures <= 0) {
      this.error(`GeoJSON must have features, exiting`);
    }

    const firstFeature = baseGeoJson.features[0];
    for (const [demo] of demographics) {
      if (!(demo in firstFeature.properties)) {
        this.error(`Demographic: "${demo}" not present in features, exiting`);
      }
    }
    for (const [prop] of geoLevels) {
      if (!(prop in firstFeature.properties)) {
        this.error(`Geolevel: "${prop}" not present in features, exiting`);
      }
    }
    for (const [prop] of voting) {
      if (!(prop in firstFeature.properties)) {
        this.error(`Voting data: "${prop}" not present in features, exiting`);
      }
    }

    this.renameProps(baseGeoJson, [...geoLevels, ...voting, ...demographics]);

    if (flags.filterPrefix) {
      this.log(`Filtering to only prefixes of: ${flags.filterPrefix}`);
      baseGeoJson.features = baseGeoJson.features.filter((f: any) =>
        f.properties[geoLevelIds[0]].startsWith(flags.filterPrefix)
      );
      this.log(`Filtered GeoJSON contains ${baseGeoJson.features.length.toString()} features`);
    }

    const topoJsonHierarchy = this.mkTopoJsonHierarchy(
      baseGeoJson,
      geoLevelIds,
      demographicIds,
      votingIds,
      simplification,
      quantization
    );

    const bbox = topoJsonHierarchy.bbox;
    if (bbox === undefined || bbox.length !== 4) {
      this.error(`Invalid bbox: "${bbox}"`);
    }

    // Alaska's Aleutian Islands cross the anti-meridian, producing a bbox that
    // spans ~360° of longitude. Detect this and fix by shifting the positive
    // (western Aleutian) longitudes to their negative equivalents.
    if (bbox[2] - bbox[0] > 180) {
      this.log("Detected anti-meridian bbox, normalizing longitudes");
      // Recompute by scanning all coordinates with positive lons shifted by -360
      let minLon = Infinity;
      let maxLon = -Infinity;
      for (const feature of baseGeoJson.features) {
        for (const ring of feature.geometry.coordinates) {
          for (const coord of ring) {
            const lon = coord[0] > 0 ? coord[0] - 360 : coord[0];
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
          }
        }
      }
      bbox[0] = minLon;
      bbox[2] = maxLon;
    }

    // Release the raw GeoJSON — the topology holds all data from here on.
    // For large states (TX, CA) this frees 10+ GB before sorting begins.
    baseGeoJson = undefined as any;
    global.gc?.();

    if (!flags.inputS3Dir) {
      this.log("No inputS3Dir provided, no sorting needed");
    } else {
      ux.action.start("Pulling down previous geo-properties for sorting");
      const prevGeoProperties = await this.readPrevGeoProperties(flags.inputS3Dir, geoLevelIds);
      ux.action.stop();

      this.log("Sorting TopoJSON based on previous version");
      const errorMessage = this.sortTopoJsonByPrev(
        topoJsonHierarchy,
        prevGeoProperties,
        geoLevelIds
      );
      if (errorMessage !== null) {
        this.error(`Error encountered while sorting TopoJSON: "${errorMessage}"`);
      }
    }

    await this.writeTopoJson(flags.outputDir, topoJsonHierarchy, demographicIds, votingIds);

    this.addGeoLevelIndices(topoJsonHierarchy, geoLevelIds);

    if (flags.writeBenchTopology) {
      // Bench input: same TopoJSON structure as topo.json, but
      // unfiltered (no filterTopoJson) and emitted *after* the
      // parent-index properties have been added. The .ctopo
      // benchmark sweep re-encodes from this file, so it must
      // contain every property the encoder would normally pack into
      // the production region.ctopo.
      await this.writeBenchTopology(flags.outputDir, topoJsonHierarchy);
    }

    // Include source geojson in output to make reprocessing easier
    this.log("Copying source file to output");
    copyFileSync(args.file, join(flags.outputDir, "input.geojson"));

    let geoLevelHierarchyInfo: GeoLevelInfo[];
    if (flags.skipTiles) {
      // Encoder-iteration shortcut: skip the multi-minute tippecanoe
      // pass and synthesize the same {id, minZoom, maxZoom} info that
      // writeVectorTiles would have returned. Existing tiles.pmtiles
      // (if any) is left in place from a prior run.
      this.log("--skip-tiles: skipping vector tile generation");
      geoLevelHierarchyInfo = geoLevelIds.map((id, idx) => ({
        id,
        minZoom: parseInt(minZooms[idx]) || 0,
        maxZoom: parseInt(maxZooms[idx]) || 14
      }));
    } else {
      this.writeIntermediaryGeoJson(flags.outputDir, topoJsonHierarchy, geoLevelIds);
      geoLevelHierarchyInfo = this.writeVectorTiles(
        flags.outputDir,
        geoLevelIds,
        minZooms,
        maxZooms,
        demographicIds,
        votingIds,
        maximumTileBytes
      );
    }

    // One container holds the global arcs, every layer's geometry CSR
    // triple, and every per-feature property (demographics, voting,
    // GEOIDs, names, parent indices) the consumer needs. The encoder
    // walks `topoJsonHierarchy.objects` and packs whatever properties
    // are attached to each geometry — the topology already carries
    // demographics + voting on the base layer geometries at this point,
    // so no manual extraction step is needed.
    ux.action.start("Writing ctopo container");
    // Per-layer parent-index sections (`${layer}/${parentKey}Idx`) are
    // read at hierarchy-load time to map geounit ids → integer indices,
    // so they belong in the open-time front-load region. addGeoLevelIndices
    // emits one `${parentKey}Idx` property per geometry per ancestor
    // geolevel; build the matching section names from the layer hierarchy.
    // geoLevelIds is base-first (e.g. ["block", "precinct", "county"]).
    // addGeoLevelIndices walks top-down and writes a `${parent}Idx`
    // property on every geometry for each ancestor geolevel — so for
    // a given layer at index `i`, the parents are at indices > i.
    // Section names land as `${layer}/${parent}Idx`.
    const frontLoadedIdxSections: string[] = votingIds
      .filter(
        id =>
          (id.startsWith("democrat") || id.startsWith("republican")) &&
          (id.endsWith("16") || id.endsWith("20") || id.endsWith("24"))
      )
      .map(id => `block/${id}`);
    for (let i = 0; i < geoLevelIds.length - 1; i++) {
      const layer = geoLevelIds[i];
      for (let j = i + 1; j < geoLevelIds.length; j++) {
        frontLoadedIdxSections.push(`${layer}/${geoLevelIds[j]}Idx`);
      }
    }
    await writeContainer(join(flags.outputDir, "region.ctopo"), topoJsonHierarchy, {
      compression: "zstd",
      frontLoadedSectionNames: frontLoadedIdxSections,
      onProgress: event => {
        if (event.stage === "compress-group") {
          const totalNote = event.total !== undefined ? `/${event.total}` : "";
          this.log(
            `  compressed region ${event.index}${totalNote}${event.detail !== undefined ? `: ${event.detail}` : ""}`
          );
        }
      }
    });
    ux.action.stop();

    this.writeGeounitHierarchy(flags.outputDir, topoJsonHierarchy, geoLevelIds);

    this.writeStaticMetadata(
      flags.outputDir,
      topoJsonHierarchy,
      geoLevelIds[geoLevelIds.length - 1],
      demographicIds,
      votingIds,
      geoLevelIds,
      bbox,
      geoLevelHierarchyInfo,
      this.getDemographicsGroups(flags.demographics)
    );

    process.exit(0);
  }

  renameProps(
    baseGeoJson: FeatureCollection<Polygon, any>,
    props: readonly [string, string][]
  ): void {
    for (const [prop, id] of props) {
      if (prop !== id) {
        this.log(`Renaming ${prop} to ${id} for ${baseGeoJson.features.length} features`);
        for (const feature of baseGeoJson.features) {
          feature.properties[id] = feature.properties[prop];
          delete feature.properties[prop];
        }
      }
    }
  }

  getDemographicsGroups(demographicsFlags: readonly string[]): readonly DemographicsGroup[] {
    return demographicsFlags.map(flags => {
      const pairs = splitPairs(flags);
      const ids = pairs.map(([, id]) => id);
      const [total, ...subgroups] = ids;
      return { total, subgroups };
    });
  }

  // Generates a TopoJSON topology with aggregated hierarchical data
  mkTopoJsonHierarchy(
    baseGeoJson: FeatureCollection<Polygon, any>,
    geoLevelIds: readonly string[],
    demographics: readonly string[],
    voting: readonly string[],
    simplification: number,
    quantization: number
  ): Topology<Objects<{}>> {
    const baseGeoLevel = geoLevelIds[0];
    this.log(`Converting to topojson with base geolevel: ${baseGeoLevel}`);
    const baseTopoJson = topology({ [baseGeoLevel]: baseGeoJson });

    this.log("Presimplifying using planar triangle area");
    const preSimplifiedBaseTopoJson = presimplify(
      baseTopoJson as Topology<Objects<{}>>,
      planarTriangleArea
    );

    this.log(`Simplifying ${baseGeoLevel} geounits with minWeight: ${simplification}`);
    const simplified = simplify(preSimplifiedBaseTopoJson, simplification);

    if (quantization === 0) {
      this.log(`Skipping quantization`);
    } else {
      this.log(`Quantizing ${baseGeoLevel} geounits with transform: ${quantization}`);
    }
    const topo = quantization === 0 ? simplified : quantize(simplified, quantization);

    // Strip references to degenerate (zero-length) arcs from every geometry's
    // arc sequence. Topojson's simplify() can reduce multi-point arcs at
    // dense multi-precinct junctions to arcs with all points collapsed to
    // one — these are no-op edges that confuse mergeArcs when the merge
    // set references both forward and reverse of the same degenerate arc
    // (e.g., CO Broomfield where two disconnected precincts share a
    // zero-length junction arc → mergeArcs "cancels" it and flips the
    // topology, turning a legit disconnected outer polygon into a hole).
    // Removing the arc references is safe because the arc adds no movement
    // to the polygon's traversal; start and end point are identical.
    const degenerateArcs = new Set<number>();
    for (let i = 0; i < topo.arcs.length; i++) {
      const arc = topo.arcs[i];
      // Arc is a sequence of [dx, dy] deltas (quantized) or [x, y] coords
      // (unquantized). In both representations a zero-length arc is
      // identified by all entries having dx=dy=0 (quantized) or all coords
      // equal (unquantized).
      let degenerate = true;
      if (quantization === 0) {
        // Unquantized: compare coords
        for (let j = 1; j < arc.length; j++) {
          if (arc[j][0] !== arc[0][0] || arc[j][1] !== arc[0][1]) {
            degenerate = false;
            break;
          }
        }
      } else {
        // Quantized: the first entry is absolute, rest are deltas.
        // Degenerate if all deltas are [0,0].
        for (let j = 1; j < arc.length; j++) {
          if (arc[j][0] !== 0 || arc[j][1] !== 0) {
            degenerate = false;
            break;
          }
        }
      }
      if (degenerate) degenerateArcs.add(i);
    }
    if (degenerateArcs.size > 0) {
      this.log(`  Stripping ${degenerateArcs.size} degenerate (zero-length) arc reference(s)`);
      const stripRefs = (arcs: any): any => {
        if (!Array.isArray(arcs)) return arcs;
        if (arcs.length > 0 && Array.isArray(arcs[0])) {
          // Recurse, then drop any rings/polys that became empty.
          return arcs.map(stripRefs).filter((sub: any) => {
            if (!Array.isArray(sub) || sub.length === 0) return false;
            // For nested arrays (polygons), require at least an outer ring.
            if (Array.isArray(sub[0])) return sub.some((r: any) => r.length > 0);
            return true;
          });
        }
        // Leaf level: array of arc indices
        return arcs.filter((k: number) => {
          const idx = k < 0 ? ~k : k;
          return !degenerateArcs.has(idx);
        });
      };
      for (const name of Object.keys(topo.objects)) {
        const obj: any = topo.objects[name];
        if (!obj.geometries) continue;
        for (const g of obj.geometries) {
          if (g.arcs) g.arcs = stripRefs(g.arcs);
        }
      }
    }

    for (const [prevIndex, geoLevel] of geoLevelIds.slice(1).entries()) {
      const currIndex = prevIndex + 1;
      const currGeoLevel = geoLevelIds[currIndex];
      const prevGeoLevel = geoLevelIds[prevIndex];

      // Note: the types defined by Topojson are lacking, and are often subtly
      // inconsistent among functions. Unfortunately, a batch of `any` types were
      // needed to be deployed here, even though it was very close without them.
      const prevGeoms: any = (topo.objects[prevGeoLevel] as any).geometries;

      this.log(`Grouping geoLevel "${geoLevel}"`);
      // Use a compound key that includes all parent geolevels to ensure uniqueness.
      // E.g. when grouping blocks into precincts, key on "county|precinct" so that
      // precincts with the same ID in different counties don't collide.
      const parentLevels = geoLevelIds.slice(currIndex + 1);
      const grouped = groupBy(prevGeoms, f => {
        const parts = [...parentLevels.map(l => f.properties[l]), f.properties[currGeoLevel]];
        return parts.join("|");
      });

      this.log(`Merging ${Object.keys(grouped).length} features`);
      const mergedGeoms: any = mapValues(grouped, (geoms: readonly [Feature]) => {
        const merged: any = mergeArcs(topo, geoms as any);
        const firstGeom = geoms[0];

        // It may be possible to do this without mutation, but it would require going
        // very against-the-grain with the topojson library, and would be less performant
        merged.properties = {};

        // Aggregate all desired demographic and voting data
        for (const ids of [demographics, voting]) {
          for (const id of ids) {
            merged.properties[id] = this.aggProperty(geoms, id);
          }
        }

        // Set the geolevel keys for this level, as well as all larger levels
        // e.g. if we're creating tracts, we want to store what tract this is for,
        // and also what county this tract belongs to. This is used for subsequent
        // hierarchy calculations, and is also needed by other parts of the
        // application, such as for constructing districs.
        //
        // Also copy the name field for this level as well as all larger levels
        for (const level of geoLevelIds.slice(currIndex)) {
          merged.properties[level] = firstGeom?.properties?.[level];

          const nameProp = `${level}_name`;
          if (firstGeom?.properties && nameProp in firstGeom.properties) {
            merged.properties[nameProp] = firstGeom.properties[nameProp];
            if (level === currGeoLevel) {
              merged.properties.name = firstGeom.properties[nameProp];
            }
          }
        }

        return merged;
      });

      topo.objects[currGeoLevel] = {
        type: "GeometryCollection",
        geometries: Object.values(mergedGeoms)
      };
    }
    // Add properties that should be available on every geometry
    for (const geoLevel of geoLevelIds) {
      const geomCollection = topo.objects[geoLevel] as GeometryCollection;
      geomCollection.geometries.forEach((geometry: GeometryObject, index) => {
        // Add an 'id' to each feature. This is implicit now but will
        // become necessary to index static data array buffers once the features
        // are converted into vector tiles.
        // We are using the id here, rather than a property, because an id is needed
        // in order to use the `setFeatureState` capability on the front-end.
        geometry.id = index;

        // Add abbreviated label
        for (const ids of [demographics, voting]) {
          for (const id of ids) {
            // @ts-ignore
            geometry.properties[abbrev(id)] = abbreviateNumber(geometry.properties[id]);
          }
        }

        // Add name if it is not already defined
        // Blocks and block groups have their FIPS code available at geometry.proprties.block[group]
        // so we can use that for the name so that the label is something useful.
        if (geometry.properties && !("name" in geometry.properties)) {
          // @ts-ignore
          const levelFips = geometry.properties[geoLevel];
          // FIPS Code format is:
          // AABBBCCCCCCDEEE
          // A = State code
          // B = County code
          // C = Tract code
          // D = Blockgroup code
          // E = Block code
          // We display blocks and blockgroups but not tracts, so we're using the following subsets
          // of the full FIPS code for each level:
          // Blockgroup: Tract code and blockgroup code (CCCCCCD)
          // Block: Blockgroup code and block code (DEEE)
          // Counties are displayed with their name.
          const localFips =
            geoLevel === "blockgroup"
              ? levelFips.substring(5)
              : geoLevel === "block"
                ? levelFips.substring(11)
                : levelFips;
          // And then we want the tooltip to display something like "Blockgroup #CCCCCCD"
          // @ts-ignore
          geometry.properties.name = `${
            geoLevel[0].toUpperCase() + geoLevel.substring(1)
          } #${localFips}`;
        }
      });
    }

    return topo;
  }

  // Helper for aggregating properties by addition
  aggProperty(geoms: readonly [Feature], key: string): number {
    return geoms.map(g => g?.properties?.[key]).reduce((a: number, b: number) => a + b, 0);
  }

  // Reader for GeoJSON files under 1GB or so. Faster than the streaming reader.
  async readSmallGeoJson(path: string): Promise<FeatureCollection<Polygon, {}>> {
    const jsonString = readFileSync(path);
    return Promise.resolve(JSON.parse(jsonString.toString()));
  }

  // Streaming reader for GeoJSON files. Works on files over 1GB, but is slow.
  async readBigGeoJson(path: string): Promise<FeatureCollection<Polygon, {}>> {
    return new Promise(resolve =>
      createReadStream(path, { encoding: "utf8" })
        .pipe(parse("features"))
        .on("data", (features: any) => {
          resolve({ type: "FeatureCollection", features });
        })
    );
  }

  // Reads previous geo-properties from S3 for sorting. Tries the post-ctopo
  // path first — open the previous prefix's `region.ctopo` over S3 Range GETs
  // and pull the small `{layer}/{geoLevelId}` columns directly, avoiding
  // the multi-hundred-MB download of the legacy geo-properties.json. Falls
  // back to that JSON only when the prefix predates the ctopo migration.
  async readPrevGeoProperties(
    inputS3Dir: string,
    geoLevelIds: readonly string[]
  ): Promise<Record<string, Record<string, unknown>[]>> {
    const s3Client = new S3Client({});
    const uriComponents = inputS3Dir.split("/");
    const bucket = uriComponents[2];
    const keyPrefix = uriComponents.slice(3).join("/");

    try {
      return await this.readPrevGeoPropertiesFromCtopo(s3Client, bucket, keyPrefix, geoLevelIds);
    } catch (err) {
      if (!isNoSuchKey(err)) throw err;
      this.log("Previous prefix has no region.ctopo; falling back to geo-properties.json");
      return this.readPrevGeoPropertiesFromJson(s3Client, bucket, keyPrefix, geoLevelIds);
    }
  }

  // Pull each `{layer}/{id}` column out of the previous region.ctopo and
  // assemble the same Record<level, Record<id, value>[]> shape the sort
  // step expects. Columns absent at a layer (e.g. `county/block`) stay
  // unset, mirroring the JSON path where missing keys read as undefined.
  async readPrevGeoPropertiesFromCtopo(
    s3Client: S3Client,
    bucket: string,
    keyPrefix: string,
    geoLevelIds: readonly string[]
  ): Promise<Record<string, Record<string, unknown>[]>> {
    const fetcher = makeRangeFetcher(async rangeHeader => {
      const res = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: `${keyPrefix}region.ctopo`,
          Range: rangeHeader
        })
      );
      const bytes = (await res.Body?.transformToByteArray()) ?? new Uint8Array();
      // Slice to exact bounds — Node Buffers may share an oversized backing
      // ArrayBuffer that would corrupt typed-array views.
      return new Uint8Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      );
    });

    const client = await CtopoClient.openWith(fetcher);
    try {
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const level of geoLevelIds) {
        const layerMeta = client.meta.layers.find(l => l.name === level);
        if (layerMeta === undefined) continue;
        const numFeatures = layerMeta.numGeometries;

        const columns: Record<string, unknown[]> = {};
        for (const id of geoLevelIds) {
          const sectionName = `${level}/${id}`;
          const entry = client.sections.find(s => s.name === sectionName);
          if (entry === undefined) continue;
          if (entry.dtype === "strings") {
            const arr = await client.strings(sectionName);
            const list: unknown[] = new Array(arr.length);
            for (let i = 0; i < arr.length; i++) list[i] = arr.get(i);
            columns[id] = list;
          } else {
            const view = (await client.property(sectionName)) as unknown as ArrayLike<number>;
            const list: unknown[] = new Array(view.length);
            for (let i = 0; i < view.length; i++) list[i] = view[i];
            columns[id] = list;
          }
        }

        const items: Record<string, unknown>[] = new Array(numFeatures);
        for (let i = 0; i < numFeatures; i++) {
          const row: Record<string, unknown> = {};
          for (const id of geoLevelIds) {
            if (id in columns) row[id] = columns[id][i];
          }
          items[i] = row;
        }
        result[level] = items;
      }
      return result;
    } finally {
      client.close();
    }
  }

  // Legacy path for prefixes published before the ctopo migration. The
  // payload is big (hundreds of MB for TX/CA/FL) and contains all
  // demographic/voting fields per feature, but we only need the geoLevelIds
  // fields for sort + verify. Spool the body to a temp file, then
  // stream-parse per level, projecting each item down to just the id
  // fields so peak memory stays small.
  async readPrevGeoPropertiesFromJson(
    s3Client: S3Client,
    bucket: string,
    keyPrefix: string,
    geoLevelIds: readonly string[]
  ): Promise<Record<string, Record<string, unknown>[]>> {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `${keyPrefix}geo-properties.json`
      })
    );

    const tmpPath = join(tmpdir(), `geo-properties-${process.pid}-${Date.now()}.json`);
    const body = response.Body as unknown as NodeJS.ReadableStream;
    await pipeline(body, createWriteStream(tmpPath));

    try {
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const levelId of geoLevelIds) {
        const items: Record<string, unknown>[] = await new Promise((resolve, reject) => {
          const out: Record<string, unknown>[] = [];
          const parser = parse(`${levelId}.*`);
          parser.on("data", (item: Record<string, unknown>) => {
            // Project to just the id fields we need — drops demographics/voting/etc
            const projected: Record<string, unknown> = {};
            for (const id of geoLevelIds) projected[id] = item[id];
            out.push(projected);
          });
          parser.on("error", reject);
          parser.on("end", () => resolve(out));
          createReadStream(tmpPath).pipe(parser);
        });
        result[levelId] = items;
      }
      return result;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }

  // Write TopoJSON file to disk
  async writeTopoJson(
    dir: string,
    topology: Topology<Objects<{}>>,
    demographics: readonly string[],
    voting: readonly string[]
  ) {
    const filteredTopojson = this.filterTopoJson(topology, demographics, voting);
    this.log("Writing topojson file");
    const path = join(dir, "topo.json");
    const output = createWriteStream(path, { encoding: "utf-8" });
    await new Promise<void>((resolve, reject) => {
      const stream = new JsonStreamStringify(filteredTopojson);
      stream.pipe(output);
      output.on("finish", resolve);
      stream.on("error", reject);
      output.on("error", reject);
    });
  }

  // Bench-only: dumps the unfiltered topology (every demographic +
  // voting field still attached, plus the parent-index properties
  // populated by addGeoLevelIndices) to topo-bench.json. The .ctopo
  // encoder benchmark reads this file as its source of truth so it
  // can re-encode under different presets without re-running the
  // multi-minute geojson → topology stages.
  async writeBenchTopology(dir: string, topology: Topology<Objects<{}>>) {
    this.log("Writing topo-bench.json (unfiltered topology for encoder bench)");
    const path = join(dir, "topo-bench.json");
    const output = createWriteStream(path, { encoding: "utf-8" });
    await new Promise<void>((resolve, reject) => {
      const stream = new JsonStreamStringify(topology);
      stream.pipe(output);
      output.on("finish", resolve);
      stream.on("error", reject);
      output.on("error", reject);
    });
  }

  filterTopoJson(
    topology: Topology<Objects<{}>>,
    demographics: readonly string[],
    voting: readonly string[]
  ): Topology<Objects<{}>> {
    // Drop all demographic and voting properties except for population to save on memory
    // When the server needs these fields it can get them from the typed array buffers
    const droppedFields = demographics.concat(voting);
    const droppedProps = droppedFields
      .concat(droppedFields.map(abbrev))
      .filter(id => id !== "population");

    return {
      ...topology,
      objects: _.mapValues(topology.objects, gc =>
        gc.type === "GeometryCollection"
          ? {
              ...gc,
              geometries: gc.geometries.map(geom => ({
                ...geom,
                properties: _.omit(geom.properties, droppedProps)
              }))
            }
          : gc
      )
    };
  }

  // Write static metadata file to disk
  writeStaticMetadata(
    dir: string,
    topology: Topology<Objects<{}>>,
    topLevelId: string,
    demographicIds: readonly string[],
    votingIds: readonly string[],
    geoLevelIds: readonly string[],
    bbox: [number, number, number, number],
    geoLevelHierarchy: GeoLevelInfo[],
    demographicsGroups: readonly DemographicsGroup[]
  ): void {
    this.log("Writing static metadata file");

    const topLevel = topology.objects[topLevelId] as GeometryCollection;
    const topLevelNames = topLevel.geometries.map(
      (g: GeometryObject<any>) => (g.properties?.name as string) || ""
    );
    const totalPopulation = topLevel.geometries.reduce(
      (sum: number, g: GeometryObject<any>) => sum + (Number(g.properties?.population) || 0),
      0
    );

    // The IStaticFile entries used to describe per-property `.buf`
    // sidecars (id + filename + dtype). The data lives in region.ctopo
    // now and the client reads it via client.property("{layer}/{id}"),
    // but the id list is still authoritative for telling consumers
    // *which* properties to aggregate. fileName / bytesPerElement /
    // unsigned are vestigial and ignored by post-migration callers.
    const idStub = (id: string): IStaticFile => ({
      id,
      fileName: "",
      bytesPerElement: 0,
      unsigned: true
    });

    const staticMetadata: IStaticMetadata = {
      demographics: demographicIds.map(idStub),
      geoLevels: geoLevelIds.slice(1).map(idStub),
      voting: votingIds.map(idStub),
      bbox,
      geoLevelHierarchy,
      demographicsGroups,
      totalPopulation,
      topLevelNames
    };

    writeFileSync(join(dir, "static-metadata.json"), JSON.stringify(staticMetadata));
  }

  // Add index and parent geolevel indices to each geounit
  addGeoLevelIndices(topology: Topology<Objects<{}>>, geoLevels: readonly string[]): void {
    const descGeoLevels = geoLevels.slice().reverse();
    const parentGeoLevels: string[] = [];
    const indexLookupPerGeoLevel: {
      [geoLevel: string]: { [geounitId: string]: number };
    } = Object.fromEntries(descGeoLevels.map(gl => [gl, {}]));

    for (const geoLevel of descGeoLevels) {
      const topoObject: any = topology.objects[geoLevel];
      if (!parentGeoLevels.length) {
        // We're at the top-most geolevel, no parents, so we only need to add indices to lookup
        topoObject.geometries.forEach((geometry: any, index: number) => {
          const geounitId: string = geometry.properties[geoLevel];
          indexLookupPerGeoLevel[geoLevel][geounitId] = index;
          geometry.properties.idx = index;
        });
      } else {
        // Add indices to lookup, and update geom properties to have references to all parent ids
        const parentGeoLevel = parentGeoLevels[parentGeoLevels.length - 1];
        const grouped = groupBy(topoObject.geometries, f => f.properties[parentGeoLevel || ""]);
        for (const geoms of Object.values(grouped)) {
          geoms.forEach((geometry: any, index: number) => {
            const geounitId: string = geometry.properties[geoLevel];
            indexLookupPerGeoLevel[geoLevel][geounitId] = index;
            geometry.properties.idx = index;

            // Update geom properties with all references to parent ids in hierarchy
            for (const parentKey of parentGeoLevels) {
              geometry.properties[`${parentKey}Idx`] =
                indexLookupPerGeoLevel[parentKey][geometry.properties[parentKey]];
            }
          });
        }
      }
      parentGeoLevels.push(geoLevel);
    }
  }

  // Convert TopoJSON to GeoJSON and write to disk
  writeIntermediaryGeoJson(
    dir: string,
    topology: Topology<Objects<{}>>,
    geoLevels: readonly string[]
  ): void {
    for (const geoLevel of geoLevels) {
      this.log(`Converting topojson to geojsonseq for ${geoLevel}`);
      const geojson = topo2feature(topology, topology.objects[geoLevel]);

      // Write as newline-delimited GeoJSON (geojsonseq) — one feature per line
      // Enables tippecanoe --read-parallel and geojson-polygon-labels --input-format=geojsonseq
      const filePath1 = join(dir, `${geoLevel}-full.geojson`);
      const filePath2 = join(dir, `${geoLevel}.geojson`);
      const fd1 = require("fs").openSync(filePath1, "w"); // eslint-disable-line
      const fd2 = require("fs").openSync(filePath2, "w"); // eslint-disable-line
      let totalDropped = 0;
      let totalNullRings = 0;
      for (const feature of (geojson as any).features) {
        if (
          feature.geometry &&
          (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon")
        ) {
          // Sanitize any null rings that topo2feature emits when an arc
          // sequence resolves to nothing (can happen after our degenerate-arc
          // strip removes all arcs from a ring). A ring that's null or has
          // <4 coords (can't form a closed polygon) is invalid — drop it.
          // If a polygon's outer ring is invalid, drop the polygon. If a
          // MultiPolygon has no valid polygons, the feature's geometry
          // becomes empty and we leave it (downstream tippecanoe skips).
          const validRing = (r: any): boolean =>
            Array.isArray(r) &&
            r.length >= 4 &&
            r.every((v: any) => Array.isArray(v) && v.length >= 2);
          const sanitizePoly = (poly: any): any[] | null => {
            if (!Array.isArray(poly) || poly.length === 0) return null;
            if (!validRing(poly[0])) return null;
            const out: any[] = [poly[0]];
            for (let i = 1; i < poly.length; i++) {
              if (validRing(poly[i])) out.push(poly[i]);
              else totalNullRings++;
            }
            return out;
          };
          if (feature.geometry.type === "Polygon") {
            const clean = sanitizePoly(feature.geometry.coordinates);
            if (!clean) {
              totalNullRings++;
              feature.geometry = { type: "Polygon", coordinates: [] };
            } else {
              feature.geometry = { type: "Polygon", coordinates: clean };
            }
          } else {
            const cleanPolys = feature.geometry.coordinates
              .map(sanitizePoly)
              .filter((p: any) => p !== null);
            if (cleanPolys.length !== feature.geometry.coordinates.length) {
              totalNullRings += feature.geometry.coordinates.length - cleanPolys.length;
            }
            feature.geometry = { type: "MultiPolygon", coordinates: cleanPolys };
          }
          const { geom, dropped } = stripDegenerateHoles(feature.geometry, 1e-12);
          feature.geometry = geom;
          totalDropped += dropped;
        }
        require("fs").writeSync(fd1, JSON.stringify(feature) + "\n"); // eslint-disable-line
        // The only properties we want are geounit hierarchy indices and optionally the name
        const stripped = {
          ...feature,
          properties: {
            idx: feature.properties.idx,
            name: feature.properties.name
          }
        };
        for (const gl of geoLevels.slice(1)) {
          stripped.properties[`${gl}Idx`] = feature.properties[`${gl}Idx`];
        }
        require("fs").writeSync(fd2, JSON.stringify(stripped) + "\n"); // eslint-disable-line
      }
      require("fs").closeSync(fd1); // eslint-disable-line
      require("fs").closeSync(fd2); // eslint-disable-line
      if (totalDropped > 0) {
        this.log(`  Dropped ${totalDropped} degenerate hole(s) from ${geoLevel}`);
      }
      if (totalNullRings > 0) {
        this.log(`  Dropped ${totalNullRings} null/invalid ring(s) from ${geoLevel}`);
      }
    }
    this.log("GeoJSON Sequence files written to disk");
  }

  // Convert GeoJSON on disk to Vector Tiles
  writeVectorTiles(
    dir: string,
    geoLevels: readonly string[],
    minZooms: readonly string[],
    maxZooms: readonly string[],
    demographics: readonly string[],
    voting: readonly string[],
    maximumTileBytes: number = 750000
  ): GeoLevelInfo[] {
    const joinedMbtiles = join(dir, "all-geounits.mbtiles");
    const inputs = geoLevels.map(geoLevel => join(dir, `${geoLevel}.geojson`));
    // Convert all layers to vector tiles in one go, to ensure simplification with
    // detection of shared borders applies to all layers at once.
    // Only apply minZoom filters (when a layer first appears), NOT maxZoom caps.
    // All layers persist up to the global maximum zoom so they share the same tile
    // geometry at every zoom level, keeping boundaries perfectly aligned and
    // enabling natural overzoom for county/precinct layers.
    this.log(`Converting geojson to vectortiles for ${geoLevels.join(", ")}`);
    const featureFilter = Object.fromEntries(
      geoLevels
        .map((geoLevel, idx) => {
          const minZoom = Number(minZooms[idx]);
          return isNaN(minZoom) ? undefined : [geoLevel, [">=", "$zoom", minZoom]];
        })
        .filter(entries => entries !== undefined) as any
    );
    tippecanoe(inputs, {
      detectSharedBorders: true,
      featureFilter: JSON.stringify(featureFilter),
      noFeatureLimit: true,
      force: true,
      readParallel: true,
      noTileCompression: true,
      noTinyPolygonReduction: true,
      maximumTileBytes,
      dropRate: 1,
      output: joinedMbtiles,
      simplification: 4,
      simplifyOnlyLowZooms: true
    });
    // Extract per-layer tiles — minZoom only, no maxZoom cap so all layers
    // exist up to the global max zoom for alignment and overzoom.
    const globalMaxZoom = maxZooms[0]; // block layer has the highest maxZoom
    const separateMbtiles = geoLevels.map(geoLevel => join(dir, `${geoLevel}.mbtiles`));
    const labelsSeq = geoLevels.map(geoLevel => join(dir, `${geoLevel}-labels.geojson`));
    const labelsMbtiles = geoLevels.map(geoLevel => join(dir, `${geoLevel}-labels.mbtiles`));
    geoLevels.forEach((geoLevel, idx) => {
      const minimumZoom = minZooms[idx];
      const input = join(dir, `${geoLevel}-full.geojson`);
      const output = separateMbtiles[idx];
      tileJoin([joinedMbtiles], {
        force: true,
        layer: geoLevel,
        maximumZoom: globalMaxZoom,
        minimumZoom,
        noTileCompression: true,
        noTileSizeLimit: true,
        output
      });
      const labelPath = labelsSeq[idx];
      const labelOutput = labelsMbtiles[idx];
      geojsonPolygonLabels(
        input,
        { collections: "largest", "input-format": "geojsonseq", "output-format": "geojsonseq" },
        { outputPath: labelPath }
      );
      tippecanoe(labelPath, {
        include: [...demographics.map(abbrev), ...voting.map(abbrev)],
        force: true,
        readParallel: true,
        maximumZoom: globalMaxZoom,
        minimumZoom,
        noTileCompression: true,
        noTileSizeLimit: true,
        dropRate: 1,
        output: labelOutput
      });
    });

    // Join per-layer tiles + labels into final output
    const outputPmtiles = join(dir, "tiles.pmtiles");
    tileJoin([...separateMbtiles, ...labelsMbtiles], {
      force: true,
      noTileSizeLimit: true,
      output: outputPmtiles
    });

    // Build geo level info from the zoom args passed to this function.
    // Previously this was read from tippecanoe's metadata.json, but with PMTiles
    // output the metadata is embedded in the file header. Since we specify
    // explicit zoom levels (not 'g' for guess), we can use the args directly.
    return geoLevels.map((id, idx) => {
      const minZoom = parseInt(minZooms[idx]) || 0;
      const maxZoom = parseInt(maxZooms[idx]) || 14;
      return { id, minZoom, maxZoom };
    });
  }

  // Writes a slimmed down JSON hierarchy of geounits to disk
  writeGeounitHierarchy(dir: string, topology: Topology, geoLevels: readonly string[]): void {
    const definition = { groups: geoLevels.slice().reverse() };
    const geounitHierarchy = this.group(topology, definition);

    this.log("Writing geounit hierarchy file");
    writeFileSync(join(dir, "geounit-hierarchy.json"), JSON.stringify(geounitHierarchy));
  }

  // Groups a topology into a hierarchy of geounits corresponding to a district definition structure
  group(topology: Topology, definition: GeoUnitDefinition): HierarchyDefinition {
    const geounitsByParentId = definition.groups.map((groupName, index) => {
      const parentCollection = topology.objects[groupName] as GeometryCollection;
      const mutableMappings: {
        [geounitId: string]: Array<Polygon | MultiPolygon>;
      } = Object.fromEntries(
        parentCollection.geometries.map((geom: GeometryObject<any>) => [
          geom.properties[groupName],
          []
        ])
      );
      const childGroupName = definition.groups[index + 1];
      if (childGroupName) {
        const childCollection = topology.objects[childGroupName] as GeometryCollection;
        childCollection.geometries.forEach((geometry: GeometryObject<any>) => {
          mutableMappings[geometry.properties[groupName]].push(geometry as unknown as Polygon);
        });
      }
      return [groupName, mutableMappings];
    });

    const firstGroup = definition.groups[0];
    const toplevelCollection = topology.objects[firstGroup] as GeometryCollection;
    return toplevelCollection.geometries.map(geom =>
      this.getNode(geom, definition, Object.fromEntries(geounitsByParentId))
    );
  }

  // Helper for recursively collecting geounit hierarchy node information
  getNode(
    geometry: GeometryObject<any>,
    definition: GeoUnitDefinition,
    geounitsByParentId: {
      [groupName: string]: { [geounitId: string]: ReadonlyArray<Polygon | MultiPolygon> };
    }
  ): HierarchyDefinition {
    const firstGroup = definition.groups[0];
    const remainingGroups = definition.groups.slice(1);
    const geomId = geometry.properties[firstGroup];
    const childGeoms = geounitsByParentId[firstGroup][geomId];

    // Recurse until we get to the base geolevel, at which point we list the base geounit indices
    return remainingGroups.length > 1
      ? childGeoms.map(childGeom =>
          this.getNode(
            childGeom as unknown as GeometryObject<any>,
            { ...definition, groups: remainingGroups },
            geounitsByParentId
          )
        )
      : childGeoms.map((childGeom: any) => childGeom.id);
  }

  // Sorts TopoJSON in the same order as a reference TopoJSON and performs structural checks.
  // If the feature count for a level differs from the previous version, that level is skipped
  // (no stable sort is possible) but processing continues for other levels.
  sortTopoJsonByPrev(
    newTopoJson: Topology<Objects<{}>>,
    prevGeoProperties: Record<string, Record<string, unknown>[]>,
    geoLevelIds: readonly string[]
  ): string | null {
    for (const level of geoLevelIds) {
      const newFeatures = (newTopoJson.objects[level] as any).geometries;
      const prevProps = prevGeoProperties[level];
      if (!prevProps) {
        this.log(`Skipping sort for ${level}: previous geo-properties missing`);
        continue;
      }
      if (newFeatures.length !== prevProps.length) {
        this.log(
          `Skipping sort for ${level}: feature count was ${prevProps.length}, is now ${newFeatures.length}`
        );
        continue;
      }
      this.log(`Sorting geolevel: ${level}`);

      // Build map of geounit id => previous index
      const prevIndexMap = new Map<string, number>();
      prevProps.forEach((props, index) => {
        prevIndexMap.set(props[level] as string, index);
      });

      const missing = newFeatures.find(
        (f: any) => !prevIndexMap.has(f.properties[level] as string)
      );
      if (missing) {
        this.log(`Skipping sort for ${level}: geounit set changed`);
        continue;
      }

      // Sort new TopoJSON using previous ordering
      newFeatures.sort((x: any, y: any) =>
        prevIndexMap.get(x.properties[level])! > prevIndexMap.get(y.properties[level])! ? 1 : -1
      );

      // Verify all geolevel attributes match between new and previous
      for (let i = 0; i < newFeatures.length; i++) {
        const newProperties = newFeatures[i].properties;
        const prevProperties = prevProps[i];
        for (const geoLevel of geoLevelIds) {
          const newProp = newProperties[geoLevel];
          const prevProp = prevProperties[geoLevel];
          if (newProp !== prevProp) {
            return `new ${geoLevel} is: ${newProp}, was: ${prevProp} at ${level}: ${newProperties[level]}`;
          }
        }
      }
    }

    return null;
  }
}

// S3 returns NoSuchKey on a missing object; the SDK surfaces it as either
// the typed error name or the underlying HTTP 404. Match both so the
// fallback fires regardless of which transport path the SDK took.
function isNoSuchKey(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

export function abbreviateNumber(value: number) {
  const suffixes = ["", "k", "m", "b", "t"];
  let shortValue = value.toPrecision(1);
  let suffixNum = 0;

  if (Math.abs(value) >= 10) {
    suffixNum = Math.floor(Math.log10(Math.abs(value)) / 3);
    const abbrevNum = value / Math.pow(1000, suffixNum);

    if (Math.log10(Math.abs(abbrevNum)) >= 2) {
      shortValue = abbrevNum.toPrecision(3);
    } else {
      shortValue = abbrevNum.toPrecision(2);
    }

    // Get rid of exponential notation in certain cases. For example:
    // > (99.5).toPrecision(2)
    // '1.0e+2'
    // > Number((99.5).toPrecision(2)).toString()
    // '100'
    shortValue = Number(shortValue).toString();

    // Account for case where result would be off due to rounding from `toPrecision` (eg. "1000k")
    // by moving up to the next thousands place.
    if (Math.abs(Number(shortValue)) === 1000) {
      shortValue = (Number(shortValue) / 1000).toString();
      suffixNum += 1;
    }
  }

  return shortValue + suffixes[suffixNum];
}
