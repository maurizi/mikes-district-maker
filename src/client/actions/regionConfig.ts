// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { createAction } from "typesafe-actions";
import { type IRegionConfig } from "../../shared/entities";

export const regionConfigsFetch = createAction("Region configs fetch")();
export const regionConfigsFetchSuccess = createAction("Region configs fetch success")<
  readonly IRegionConfig[]
>();
export const regionConfigsFetchFailure = createAction("Region configs fetch failure")<string>();
