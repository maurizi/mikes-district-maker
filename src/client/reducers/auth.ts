// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { createReducer } from "typesafe-actions";

import { type LoopAction } from "../actions";
import { showPasswordResetNotice } from "../actions/auth";

export interface AuthState {
  readonly passwordResetNoticeShown: boolean;
}

export const initialState: AuthState = { passwordResetNoticeShown: false };

const authReducer = createReducer<AuthState, LoopAction>(initialState).handleAction(
  showPasswordResetNotice,
  (state, action) => ({
    passwordResetNoticeShown: action.payload
  })
);

export default authReducer;
