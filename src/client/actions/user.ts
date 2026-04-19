// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { createAction } from "typesafe-actions";
import { type IUser } from "../../shared/entities";

export const userFetch = createAction("User fetch")();
export const userFetchSuccess = createAction("User fetch success")<IUser>();
export const userFetchFailure = createAction("User fetch failure")<string>();
