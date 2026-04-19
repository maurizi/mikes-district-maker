// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { combineReducers } from "redux-loop";
import { getType } from "typesafe-actions";

import { type LoopAction } from "./actions";
import { resetState } from "./actions/root";
import authReducer, { type AuthState, initialState as initialAuthState } from "./reducers/auth";
import organizationReducer, {
  type OrganizationState,
  initialState as initialOrganizationState
} from "./reducers/organization";
import organizationJoinReducer, {
  type OrganizationJoinState,
  initialState as initialOrganizationJoinState
} from "./reducers/organizationJoin";
import projectsReducer, {
  initialState as initialProjectsState,
  type ProjectsState
} from "./reducers/projects";
import regionConfigReducer, {
  initialState as initialRegionConfigState,
  type RegionConfigState
} from "./reducers/regionConfig";
import organizationProjectsReducer, {
  initialState as intialOrganizationProjectsState,
  type OrganizationProjectsState
} from "./reducers/organizationProjects";
import userReducer, { initialState as initialUserState, type UserState } from "./reducers/user";
import projectReducer, { type ProjectState, initialProjectState } from "./reducers/project";
import projectOptionsReducer, {
  type ProjectOptionsState,
  initialProjectOptionsState
} from "./reducers/projectOptions";
import projectModalsReducer, {
  type ProjectModalsState,
  initialProjectModalsState
} from "./reducers/projectModals";

export interface State {
  readonly auth: AuthState;
  readonly project: ProjectState;
  readonly projectOptions: ProjectOptionsState;
  readonly projectModals: ProjectModalsState;
  readonly projects: ProjectsState;
  readonly organization: OrganizationState;
  readonly organizationJoin: OrganizationJoinState;
  readonly organizationProjects: OrganizationProjectsState;
  readonly regionConfig: RegionConfigState;
  readonly user: UserState;
}

export const initialState: State = {
  auth: initialAuthState,
  organization: initialOrganizationState,
  organizationJoin: initialOrganizationJoinState,
  organizationProjects: intialOrganizationProjectsState,
  project: initialProjectState,
  projectOptions: initialProjectOptionsState,
  projectModals: initialProjectModalsState,
  projects: initialProjectsState,
  regionConfig: initialRegionConfigState,
  user: initialUserState
};

const allReducers = combineReducers({
  auth: authReducer,
  organization: organizationReducer,
  organizationJoin: organizationJoinReducer,
  organizationProjects: organizationProjectsReducer,
  project: projectReducer,
  projectOptions: projectOptionsReducer,
  projectModals: projectModalsReducer,
  projects: projectsReducer,
  regionConfig: regionConfigReducer,
  user: userReducer
});

export default (state = initialState, action: LoopAction) => {
  const newState: State | undefined =
    action && action.type === getType(resetState) ? undefined : state;
  return allReducers(newState, action);
};
