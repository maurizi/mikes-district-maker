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
