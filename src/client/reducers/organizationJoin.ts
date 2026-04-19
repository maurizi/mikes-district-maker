// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Cmd, type Loop, loop } from "redux-loop";
import { getType } from "typesafe-actions";

import { type LoopAction } from "../actions";
import {
  joinOrganization,
  joinOrganizationSuccess,
  joinOrganizationFailure,
  leaveOrganization,
  leaveOrganizationSuccess,
  leaveOrganizationFailure
} from "../actions/organizationJoin";

import { type IOrganization } from "../../shared/entities";
import { addUserToOrganization, removeUserFromOrganization } from "../api";
import { showResourceFailedToast } from "../functions";
import { type Resource } from "../resource";
import { organizationFetch } from "../actions/organization";

export type OrganizationJoinState = Resource<IOrganization>;

export const initialState = {
  isPending: false
};

const organizationJoinReducer = (
  state: OrganizationJoinState = initialState,
  action: LoopAction
): OrganizationJoinState | Loop<OrganizationJoinState> => {
  switch (action.type) {
    case getType(joinOrganization): {
      return loop(
        {
          isPending: true
        },
        Cmd.run(
          () =>
            addUserToOrganization(action.payload.organization, action.payload.user).then(() => {
              return action.payload.organization;
            }),
          {
            successActionCreator: joinOrganizationSuccess,
            failActionCreator: joinOrganizationFailure
          }
        )
      );
    }
    case getType(joinOrganizationSuccess):
      return loop(
        {
          ...state
        },
        Cmd.action(organizationFetch(action.payload))
      );
    case getType(joinOrganizationFailure):
      return loop(
        {
          errorMessage: action.payload
        },
        Cmd.run(showResourceFailedToast)
      );
    case getType(leaveOrganization): {
      return loop(
        {
          isPending: true
        },
        Cmd.run(
          () =>
            removeUserFromOrganization(action.payload.organization, action.payload.user).then(
              () => {
                return action.payload.organization;
              }
            ),
          {
            successActionCreator: leaveOrganizationSuccess,
            failActionCreator: leaveOrganizationFailure
          }
        )
      );
    }
    case getType(leaveOrganizationSuccess):
      return loop(
        {
          ...state
        },
        Cmd.action(organizationFetch(action.payload))
      );
    case getType(leaveOrganizationFailure):
      return loop(
        {
          errorMessage: action.payload
        },
        Cmd.run(showResourceFailedToast)
      );
    default:
      return state;
  }
};

export default organizationJoinReducer;
