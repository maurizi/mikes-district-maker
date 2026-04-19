// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { type Loop } from "redux-loop";
import { getType } from "typesafe-actions";

import { type LoopAction } from "../actions";

import {
  showAdvancedEditingModal,
  showCopyMapModal,
  setImportFlagsModal,
  toggleKeyboardShortcutsModal,
  showSubmitMapModal
} from "../actions/projectModals";
import { resetProjectState } from "../actions/root";

export interface ProjectModalsState {
  readonly showAdvancedEditingModal: boolean;
  readonly showCopyMapModal: boolean;
  readonly showKeyboardShortcutsModal: boolean;
  readonly showImportFlagsModal: boolean;
  readonly showSubmitMapModal: boolean;
}

export const initialProjectModalsState: ProjectModalsState = {
  showAdvancedEditingModal: false,
  showCopyMapModal: false,
  showImportFlagsModal: false,
  showKeyboardShortcutsModal: false,
  showSubmitMapModal: false
};

const districtDrawingReducer = (
  state: ProjectModalsState = initialProjectModalsState,
  action: LoopAction
): ProjectModalsState | Loop<ProjectModalsState> => {
  switch (action.type) {
    case getType(resetProjectState):
      return {
        ...state,
        ...initialProjectModalsState
      };
    case getType(showAdvancedEditingModal):
      return {
        ...state,
        showAdvancedEditingModal: action.payload
      };
    case getType(toggleKeyboardShortcutsModal):
      return {
        ...state,
        showKeyboardShortcutsModal: !state.showKeyboardShortcutsModal
      };
    case getType(showCopyMapModal):
      return {
        ...state,
        showCopyMapModal: action.payload
      };
    case getType(setImportFlagsModal):
      return {
        ...state,
        showImportFlagsModal: action.payload
      };
    case getType(showSubmitMapModal):
      return {
        ...state,
        showSubmitMapModal: action.payload
      };
    default:
      return state as never;
  }
};

export default districtDrawingReducer;
