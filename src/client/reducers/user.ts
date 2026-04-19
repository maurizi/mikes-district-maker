// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Cmd, type Loop, loop } from "redux-loop";
import { getType } from "typesafe-actions";

import { type LoopAction } from "../actions";
import { userFetch, userFetchFailure, userFetchSuccess } from "../actions/user";

import { type IUser } from "../../shared/entities";
import { fetchUser } from "../api";
import { showResourceFailedToast } from "../functions";
import { type Resource } from "../resource";

export type UserState = Resource<IUser>;

export const initialState = {
  isPending: false
};

const userReducer = (
  state: UserState = initialState,
  action: LoopAction
): UserState | Loop<UserState> => {
  switch (action.type) {
    case getType(userFetch):
      return loop(
        {
          isPending: true
        },
        Cmd.run(fetchUser, {
          successActionCreator: userFetchSuccess,
          failActionCreator: userFetchFailure,
          args: [] as Parameters<typeof fetchUser>
        })
      );
    case getType(userFetchSuccess):
      return {
        resource: action.payload
      };
    case getType(userFetchFailure):
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

export default userReducer;
