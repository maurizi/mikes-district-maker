// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { type Action as ReduxAction } from "redux";
import { type ActionType } from "typesafe-actions";

import type * as authActions from "./actions/auth";
import type * as districtDrawingActions from "./actions/districtDrawing";
import type * as organizationActions from "./actions/organization";
import type * as organizationJoinActions from "./actions/organizationJoin";
import type * as organizationProjectActions from "./actions/organizationProjects";
import type * as projectDataActions from "./actions/projectData";
import type * as projectOptionsActions from "./actions/projectOptions";
import type * as projectModalsActions from "./actions/projectModals";
import type * as projectsActions from "./actions/projects";
import type * as regionConfigActions from "./actions/regionConfig";
import type * as rootActions from "./actions/root";
import type * as userActions from "./actions/user";

export type AuthAction = ActionType<typeof authActions>;
export type DistrictDrawingAction = ActionType<typeof districtDrawingActions>;
export type OrganizationAction = ActionType<typeof organizationActions>;
export type OrganizationJoinAction = ActionType<typeof organizationJoinActions>;
export type OrganizationProjectsAction = ActionType<typeof organizationProjectActions>;
export type ProjectDataAction = ActionType<typeof projectDataActions>;
export type ProjectOptionsAction = ActionType<typeof projectOptionsActions>;
export type ProjectModalsAction = ActionType<typeof projectModalsActions>;
export type ProjectsAction = ActionType<typeof projectsActions>;
export type RegionConfigAction = ActionType<typeof regionConfigActions>;
export type RootAction = ActionType<typeof rootActions>;
export type UserAction = ActionType<typeof userActions>;

export type Action =
  | AuthAction
  | DistrictDrawingAction
  | OrganizationAction
  | OrganizationProjectsAction
  | OrganizationJoinAction
  | ProjectDataAction
  | ProjectOptionsAction
  | ProjectModalsAction
  | ProjectsAction
  | RegionConfigAction
  | RootAction
  | UserAction;

// redux-loop's LoopReducer expects actions to include its internal sentinel type.
// Our reducers handle this via their default/fallthrough case.
export type LoopAction = Action | ReduxAction<"@@REDUX_LOOP/ENFORCE_DEFAULT_HANDLING">;
