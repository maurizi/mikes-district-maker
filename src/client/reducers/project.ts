// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { reduceReducers } from "redux-loop";

import districtDrawingReducer, {
  type DistrictDrawingState,
  initialDistrictDrawingState
} from "./districtDrawing";
import projectDataReducer, { type ProjectDataState, initialProjectDataState } from "./projectData";

export const initialProjectState = { ...initialProjectDataState, ...initialDistrictDrawingState };

export type ProjectState = ProjectDataState & DistrictDrawingState;

const projectReducer = reduceReducers(projectDataReducer, districtDrawingReducer);

export default projectReducer;
