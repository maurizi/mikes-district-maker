DistrictBuilder command-line interface
======================================

Commands are run via `./scripts/manage` from the project root, which executes inside the manage Docker container. For example:

```bash
./scripts/manage process-geojson --help
```

# Commands

* [`manage-py prepare-region-data STATEFIPS STATEABBR`](#manage-py-prepare-region-data-statefips-stateabbr) — Python pipeline, no block splitting (recommended for new regions)
* [`manage prepare-dev-data STATEFIPS STATEABBR`](#manage-prepare-dev-data-statefips-stateabbr) — Legacy TS pipeline with block splitting
* [`manage process-geojson FILE`](#manage-process-geojson-file)
* [`manage publish-region STATICDATADIR COUNTRYCODE REGIONCODE REGIONNAME`](#manage-publish-region-staticdatadir-countrycode-regioncode-regionname)
* [`manage update-region STATICDATADIR UPDATES3DIR`](#manage-update-region-staticdatadir-updates3dir)
* [`manage bulk-reprocess-regions CONFIGFILE`](#manage-bulk-reprocess-regions-configfile)
* [`manage update-organization CONFIG`](#manage-update-organization-config)
* [`manage create-random-projects NUMBER [REGION]`](#manage-create-random-projects-number-region)

## `manage-py prepare-region-data STATEFIPS STATEABBR`

Python-based alternative to `prepare-dev-data`, following the Redistricting Data Hub methodology. Each TIGER block is treated as an atomic unit and assigned in full to whichever VEST precinct covers the majority of its area (via [`maup.assign`](https://maup.readthedocs.io/)). Votes are disaggregated from precincts to blocks weighted by VAP_MOD (VAP minus adult incarcerated population) and reconciled so per-precinct totals are preserved exactly.

Unlike `prepare-dev-data`, this command:
- Does not split blocks at precinct boundaries (no `-1`, `-2` sub-block IDs).
- Skips the noding/polygonize/vertex-patching geometry repair path.
- Produces a precinct layer that is the dissolved union of its assigned blocks (block-resolution approximation of the VEST shape).

The output GeoJSON is drop-in compatible with `process-geojson` — same property schema, same hierarchy keys (`block`, `precinct`, `county`), so the downstream `process-geojson → publish-region` steps do not change.

```
USAGE
  $ manage-py prepare-region-data STATEFIPS STATEABBR -v <vest.zip> -p <field> [OPTIONS]

ARGUMENTS
  STATEFIPS  2-digit state FIPS code (e.g. 10 for Delaware)
  STATEABBR  State abbreviation (e.g. DE)

FLAGS
  -v, --vest=<path>               Path to VEST election shapefile zip (required)
  -p, --vest-precinct-field=<s>   VEST precinct-id field name; optionally `idField:nameField` for
                                  display name (required)
  -o, --output=<path>             [default: dev-data/output.geojson] Output GeoJSON file path
  -c, --census-cache=<prefix>     Path prefix for cached Census blocks + demographics (shares
                                  shape with prepare-dev-data)
  -a, --additional-vest=<pairs>   Comma-separated precinctField:path pairs for additional
                                  election years (each year produces year-suffixed vote columns)
      --bef-dir=<path>            Directory containing per-state BEF CSV subdirectories
                                  (used for nearest-precinct fallback warnings)
      --adj-dir=<path>            Directory containing {STATE}.csv adjusted-PL files

EXAMPLES
  # Delaware with 2020 presidential voting data. Paths are inside the
  # manage container, where ./dev-data on the host is mounted at
  # /home/node/app/manage/dev-data (the working directory). VEST zips
  # staged under dev-data/staging/, matching data-import/bulk-vest/.
  $ ./scripts/manage-py prepare-region-data 10 DE \
      --vest dev-data/staging/de_2020.zip -p PRECINCT -o dev-data/de.geojson

  # Then feed into process-geojson unchanged:
  $ ./scripts/manage process-geojson dev-data/de.geojson \
      -l block,precinct,county -n 8,4,0 -x 14,12,8 \
      -d population,white,black,asian,hispanic,other \
      -v democrat,republican,otherparty \
      -o dev-data/de-output/
```

## `manage prepare-dev-data STATEFIPS STATEABBR`

Download Census 2020 block data and demographics, optionally join VEST election voting data, and output a GeoJSON file ready for `process-geojson`.

This command automates the data pipeline for creating DistrictBuilder region data from public sources:
1. Downloads Census TIGER block shapefiles (geometry)
2. Downloads Block Assignment Files (block → precinct/VTD mapping)
3. Fetches demographics from the Census API (population, race)
4. Optionally joins VEST election shapefile voting data

```
USAGE
  $ manage prepare-dev-data STATEFIPS STATEABBR [-v <vest.zip>] [-p <field>] [-o <output>]

ARGUMENTS
  STATEFIPS  2-digit state FIPS code (e.g. 10 for Delaware, 44 for Rhode Island)
  STATEABBR  State abbreviation (e.g. DE, RI)

FLAGS
  -v, --vest=<path>               Path to VEST election shapefile zip (optional)
  -p, --vestPrecinctField=<name>  [default: PRECINCT] Field name for precinct ID in VEST shapefile
                                  (use VTDST20 for Rhode Island)
  -o, --output=<path>             [default: dev-data/output.geojson] Output GeoJSON file path

EXAMPLES
  # Delaware with 2020 presidential voting data
  $ manage prepare-dev-data 10 DE --vest /data/de_2020.zip -o dev-data/de.geojson

  # Rhode Island (uses VTDST20 for precinct field)
  $ manage prepare-dev-data 44 RI --vest /data/ri_2020.zip -p VTDST20 -o dev-data/ri.geojson

  # Then process the output:
  $ manage process-geojson dev-data/de.geojson \
      -l block,precinct,county -n 8,4,0 -x 14,12,8 \
      -d population,white,black,asian,hispanic,other \
      -v democrat,republican,otherparty \
      -o dev-data/de-output/
```

The output GeoJSON has these properties on each feature:
- `block` — Census block GEOID (15-digit)
- `precinct` — VTD/precinct ID from Block Assignment File
- `county` — County FIPS code (3-digit)
- `population`, `white`, `black`, `asian`, `hispanic`, `other` — Census demographics
- `democrat`, `republican`, `otherparty` — Aggregated presidential votes (if VEST data provided)

## `manage bulk-reprocess-regions CONFIGFILE`

use a configuration file to process and update many regions

```
USAGE
  $ manage bulk-reprocess-regions CONFIGFILE

ARGUMENTS
  CONFIGFILE
      Path to a configuration file containing information on how each region should be processed.

      The configuration file should be a JSON file with the following format:
      {
         "US": {
           "DE": {
             "geojsonFile": "data/input/de.geojson",
             "updateS3Dir": "s3://path/to/timestamped/data/files/like/US/DE/2021-09-23T18:43:42.300Z/",
             "processGeojsonFlags": [
               "-n",
               "12,4,4",
               "-x",
               "12,12,12",
               "-d",
               "population,white,black,asian,hispanic,native:nativeAmerican,pacific:pacificIslander"
             ]
           }
         }
      }

      Within each state, the parameters are as follows:
      - geojsonFile: Behaves identically to the equivalent parameter to the process-geojson command
      - updateS3Dir: Behaves identically to the equivalent parameter to the update-region command, and is also used as the 
      --inputS3Dir to process-geojson.
      - processGeojsonFlags: All flags that could be passed to the process-geojson command are valid EXCEPT --inputS3Dir; 
      flags should be entered as an array of strings.

OPTIONS
  --dryRun  Dry run; only prints actions that would be taken.
```

## `manage create-random-projects NUMBER [REGION]`

creates randomly generated projects for development testing

```
USAGE
  $ manage create-random-projects NUMBER [REGION]

ARGUMENTS
  NUMBER  Number of projects to create
  REGION  [default: all] Region code to create projects for, or 'all'. Defaults to 'all'
```

## `manage process-geojson FILE`

process GeoJSON into desired output files

```
USAGE
  $ manage process-geojson FILE

OPTIONS
  -b, --big
      Use this for big GeoJSON files (~1GB+) that need to be streamed

  -d, --demographics=demographics
      [default: population,white,black,asian,hispanic,other] Comma-separated group of census demographics to select and 
      aggregate
             To use a different name for the property from the GeoJSON property, separate values by ':'
             e.g. -d pop:population,wht:white,blk:black

             The first value in the group will be used as population, and the remaining values will be displayed
             as a percentage of that population.

             To create multiple groups, use the -d option once per group.
             e.g. -d population,white,black,asian,hispanic,other -d "VAP,VAP White, VAP Black, VAP Asian, VAP Hispanic, 
      VAP Other"

  -f, --filterPrefix=filterPrefix
      Filter to only base geounits containing the specified prefix

  -l, --levels=levels
      [default: block,blockgroup,county] Comma-separated geolevel hierarchy: smallest to largest
             To use a different name for the layer ID from the GeoJSON property, separate values by ':'
             e.g. -l geoid:block,blockgroupuuid:blockgroup,county

  -n, --levelMinZoom=levelMinZoom
      [default: 8,0,0] Comma-separated minimum zoom level per geolevel, must match # of levels

  -o, --outputDir=outputDir
      [default: ./] Directory to output files

  -q, --quantization=quantization
      [default: 1e5] Topojson quantization transform, 0 to skip

  -s, --simplification=simplification
      [default: 0.0000000025] Topojson simplification amount (minWeight)

  -u, --inputS3Dir=inputS3Dir
      S3 directory for the previous run if we will be updating in-place

  -v, --voting=voting
      Comma-separated election data to select and aggregate
             To use a different name for the layer property from the GeoJSON property, separate values by ':'
             e.g. -v voterep:republican,votedem:democrat,voteoth:other

  -x, --levelMaxZoom=levelMaxZoom
      [default: g,g,g] Comma-separated maximum zoom level per geolevel, must match # of levels

DESCRIPTION
  Note: this can be a very memory-intensive operation,
  depending on the size of the GeoJSON. If you receive
  an error related to memory usage, you can increase
  the Node.js memory limit by setting the following
  environment variable (as large as needed):

  NODE_OPTIONS="--max-old-space-size=14336"

  Relatedly, set the -b flag for very large GeoJSON files
  that need to be streamed. This is slower, so only use
  it when necessary (file sizes ~1GB+).
```

## `manage publish-region STATICDATADIR COUNTRYCODE REGIONCODE REGIONNAME`

upload processed region files to S3

```
USAGE
  $ manage publish-region STATICDATADIR COUNTRYCODE REGIONCODE REGIONNAME

ARGUMENTS
  STATICDATADIR  Directory of the region's static data (the output of `process-geojson`)
  COUNTRYCODE    Country code, e.g. US
  REGIONCODE     Region code, e.g. PA
  REGIONNAME     Name of the region, e.g. Pennsylvania

OPTIONS
  -b, --bucketName=bucketName  [default: global-districtbuilder-dev-us-east-1] Bucket to upload the files to
```

## `manage update-organization CONFIG`

update or create organization information from a YAML configuration

```
USAGE
  $ manage update-organization CONFIG

ARGUMENTS
  CONFIG  Path to YAML configuration file with organization details
```

## `manage update-region STATICDATADIR UPDATES3DIR`

update processed region files in-place on S3

```
USAGE
  $ manage update-region STATICDATADIR UPDATES3DIR

ARGUMENTS
  STATICDATADIR  Directory of the region's static data (the output of `process-geojson`)
  UPDATES3DIR    S3 directory to update in-place
```
<!-- commandsstop -->
