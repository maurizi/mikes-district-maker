import { createReducer } from "typesafe-actions";

import { LoopAction } from "../actions";
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
