/* Adapted from 'node-tippecanoe' */

import { execSync } from "child_process";
import kebabCase from "kebab-case";
import chalk from "chalk";

function shellExec(cmd: string, args: string[], outputPath?: string) {
  const commandAndArgs = `${cmd} ${args.join(" ")}`;
  const fullCommand = outputPath ? `${commandAndArgs} >${outputPath}` : commandAndArgs;
  console.log(chalk.green(fullCommand));
  console.log(execSync(fullCommand, { maxBuffer: 1024 * 1024 * 1024 /* 1Gb */ }));
}

function execCmd(
  cmd: string,
  layerFiles: string | string[] = [],
  params: Record<string, any>,
  options: { async?: boolean; outputPath?: string } = {}
) {
  function quotify(s: any): string {
    if (typeof s === "object") {
      s = JSON.stringify(s);
    } else {
      s = String(s);
    }
    return !options.async && s.match(/[ "[]/) ? `'${s}'` : s;
  }
  function makeParam(key: string, value: any): string {
    if (Array.isArray(value)) {
      return value.map((v: any) => makeParam(key, v)).join(" ");
    }
    if (value === false) {
      return "";
    }
    const short = key.length <= 2;
    const param = short ? `-${key}` : `--${kebabCase(key)}`;
    if (value === true) {
      return param;
    }
    return short ? `${param}${quotify(value)}` : `${param}=${quotify(value)}`;
  }
  const paramStrs = Object.keys(params)
    .map(k => makeParam(k, params[k]))
    .filter(Boolean);
  const files = !Array.isArray(layerFiles) ? [layerFiles] : layerFiles;

  const args = [...paramStrs, ...files.map(quotify)];
  shellExec(cmd, args, options.outputPath);
}

export const geojsonPolygonLabels = (
  geojsonPath: string | string[],
  params: Record<string, any>,
  options: { async?: boolean; outputPath?: string } = {}
) => execCmd("node_modules/.bin/geojson-polygon-labels", geojsonPath, params, options);

export const tippecanoe = (
  layerFiles: string | string[],
  params: Record<string, any>,
  options: { async?: boolean; outputPath?: string } = {}
) => execCmd("tippecanoe", layerFiles, params, options);

export const tileJoin = (
  layerFiles: string | string[],
  params: Record<string, any>,
  options: { async?: boolean; outputPath?: string } = {}
) => execCmd("tile-join", layerFiles, params, options);
