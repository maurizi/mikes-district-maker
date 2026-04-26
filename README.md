# DistrictBuilder

This repository is an independent personal fork of [DistrictBuilder](https://github.com/PublicMapping/districtbuilder), which was originally developed by Azavea, Inc. (acquired by Element 84 in 2023) and the Public Mapping Project. The user-facing product running from this fork is rebranded as "Mike's District Maker" and is not affiliated with, supported by, or endorsed by PublicMapping, Azavea, or Element 84.

## Overview

DistrictBuilder is web-based, open source software for collaborative redistricting.

## License

- The original DistrictBuilder code is © 2020 Azavea, Inc. and licensed under the Apache License, Version 2.0 (see [`LICENSE`](LICENSE)).
- Modifications on this fork are © 2026 Michael Maurizi Jr. and licensed under the GNU Affero General Public License, version 3 or later (see [`LICENSE-AGPL`](LICENSE-AGPL)).
- The combined work, as distributed here, is licensed under AGPL-3.0-or-later (Apache-2.0 → AGPL-3.0 is a one-way compatible upgrade). See [`NOTICE`](NOTICE) for the full attribution statement.
- When this code is run as a network service, AGPL §13 requires that the Corresponding Source be offered to users of the service. Operators deploying this fork must ensure their running UI links to the public source at the deployed commit.

- [Requirements](#requirements)
- [Development](#development)
  - [Getting Started](#getting-started)
  - [Remote Server Proxy](#remote-server-proxy)
  - [Development Data](#development-data)
  - [Project Organization](#project-organization)
  - [Stack](#stack)
  - [Ports](#ports)
- [Scripts](#scripts)
- [Command Line Interface](#command-line-interface)

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Engine and Docker Compose v2)
- An AWS credential profile named `district-builder` for S3 access

## Development

### Getting Started

Run `scripts/setup` to prepare the development environment:

```bash
./scripts/setup
```

Then bring up all services:

```bash
./scripts/server
```

This starts the PostgreSQL/PostGIS database, NestJS backend, and Vite dev server. The frontend is available at [http://localhost:3003](http://localhost:3003) with hot module replacement. The NestJS backend restarts automatically when changes are made.

#### Windows

For Windows, install [WSL2](https://docs.microsoft.com/en-us/windows/wsl/install) and [Docker Desktop](https://hub.docker.com/editions/community/docker-ce-desktop-windows) with the [WSL2-based Docker backend](https://docs.docker.com/desktop/windows/wsl/), then follow the Linux instructions from within WSL2.

### Remote Server Proxy

Develop the client against a remote server using the `BASE_URL` environment variable:

```bash
BASE_URL=https://app.staging.districtbuilder.org docker compose up client
```

### PlanScore API Integration

You will need a PlanScore API token to test the PlanScore integration. Email info@planscore.org for a token, then run `./scripts/bootstrap` to create a `.env` file in the server directory and set the `PLAN_SCORE_API_TOKEN` variable.

### Development Data

#### Using pre-processed data

1. Sign up for an account at [http://localhost:3003](http://localhost:3003)
2. Load testing data: `./scripts/load-dev-data`
3. Confirm your email by clicking the activation link printed in the terminal

#### Preparing data from Census sources

Two pipelines are available for generating per-block input GeoJSON:

- **`prepare-region-data`** (Python, recommended for new regions) — follows the Redistricting Data Hub methodology: TIGER blocks are the atomic unit, votes are disaggregated from precincts by VAP_MOD weighting, and precincts are rendered as the dissolved union of their assigned blocks. No block splitting.
- **`prepare-dev-data`** (legacy TypeScript) — splits TIGER blocks at VEST precinct boundaries to preserve original precinct geometry at sub-block resolution.

Both emit the same GeoJSON property schema, so `process-geojson` and `publish-region` are unchanged.

```bash
# VEST zips are staged under dev-data/staging/, which is mounted into the
# manage container at /home/node/app/manage/dev-data/staging/.

# Python pipeline (no block splitting)
./scripts/manage-py prepare-region-data 10 DE \
    --vest dev-data/staging/de_2020.zip -p PRECINCT -o dev-data/de.geojson

# ...or the legacy TypeScript pipeline (splits blocks)
./scripts/manage prepare-dev-data 10 DE \
    --vest dev-data/staging/de_2020.zip -o dev-data/de.geojson

# Process into tiles and static files
./scripts/manage process-geojson dev-data/de.geojson \
    -l block,precinct,county -n 8,4,0 -x 14,12,8 \
    -d population,white,black,asian,hispanic,other \
    -v democrat,republican,otherparty \
    -o dev-data/de-output/

# Publish to S3
./scripts/manage publish-region dev-data/de-output US DE Delaware
```

See the [manage README](src/manage/README.md) for full documentation of all CLI commands.

#### Processing custom GeoJSON

You can also prepare your own GeoJSON with boundaries and demographic data. The input GeoJSON needs properties for geographic hierarchy levels (e.g. `block`, `blockgroup`, `county`) and demographic fields (e.g. `population`, `white`, `black`). See the [manage README](src/manage/README.md#manage-process-geojson-file) for details on formatting and processing.

### Project Organization

```
.
├── package.json (Vite frontend)
├── vite.config.ts
├── src
│   ├── client (React frontend)
│   ├── manage (CLI for data processing — oclif)
│   │   ├── package.json
│   ├── server (NestJS backend)
│   │   ├── package.json
│   └── shared (Code shared between frontend and backend)
```

### Stack

- [TypeScript](https://www.typescriptlang.org/) for type safety
- [React 19](https://react.dev/) as a declarative view layer
- [Redux](https://redux.js.org/) + [redux-loop](https://redux-loop.js.org/) for state and effect management
- [MapLibre GL](https://maplibre.org/) + [Protomaps](https://protomaps.com/) for map rendering with self-hosted PMTiles basemap
- [Vite](https://vite.dev/) for frontend builds and dev server
- [PostgreSQL](https://www.postgresql.org/) + [PostGIS](https://postgis.net/) for the database
- [NestJS 11](https://nestjs.com/) for the backend web server
- [TypeORM](https://typeorm.io/) for database queries and migrations
- [tippecanoe](https://github.com/felt/tippecanoe) for generating PMTiles vector tiles
- [ts.data.json](https://github.com/joanllenas/ts.data.json) for JSON decoding

### Ports

| Port                          | Service |
| ----------------------------- | ------- |
| [3003](http://localhost:3003) | Vite    |
| [3005](http://localhost:3005) | NestJS  |

## Scripts

| Name            | Description                                                               |
| --------------- | ------------------------------------------------------------------------- |
| `cibuild`       | Build application for staging or a release                                |
| `cipublish`     | Publish container images to Elastic Container Registry                    |
| `dbshell`       | Enter a database shell                                                    |
| `infra`         | Execute Terraform subcommands with remote state management                |
| `load-dev-data` | Load development data for testing                                         |
| `manage`        | Execute commands with the `manage` CLI tool                               |
| `migration`     | Execute TypeORM migration CLI commands                                    |
| `server`        | Bring up all services required for the project                            |
| `setup`         | Setup the project's development environment                               |
| `test`          | Run linters and tests                                                     |
| `update`        | Build container images, update dependencies, and run database migrations  |
| `yarn`          | Execute Yarn CLI commands                                                 |

## Command Line Interface

A command line interface is available for data processing operations.
See `src/manage/README.md` for more info.
