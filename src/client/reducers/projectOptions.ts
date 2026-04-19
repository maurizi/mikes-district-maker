// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { type Loop } from "redux-loop";
import { getType } from "typesafe-actions";

import { type LoopAction } from "../actions";
import { type ElectionYear } from "../types";

import {
  toggleLimitDrawingToWithinCounty,
  setElectionYear,
  setSelectedOffice,
  setPopulationKey
} from "../actions/projectOptions";
import { resetProjectState } from "../actions/root";
import { type GroupTotal } from "../../shared/entities";

export interface ProjectOptionsState {
  readonly limitSelectionToCounty: boolean;
  readonly electionYear: ElectionYear;
  readonly selectedOffice: string;
  readonly populationKey: GroupTotal;
}

export const initialProjectOptionsState: ProjectOptionsState = {
  limitSelectionToCounty: false,
  electionYear: "16",
  selectedOffice: "",
  populationKey: "population"
};

const projectOptionsReducer = (
  state: ProjectOptionsState = initialProjectOptionsState,
  action: LoopAction
): ProjectOptionsState | Loop<ProjectOptionsState> => {
  switch (action.type) {
    case getType(resetProjectState):
      return {
        ...state,
        ...initialProjectOptionsState
      };
    case getType(toggleLimitDrawingToWithinCounty):
      return {
        ...state,
        limitSelectionToCounty: !state.limitSelectionToCounty
      };
    case getType(setElectionYear):
      return {
        ...state,
        electionYear: action.payload
      };
    case getType(setSelectedOffice):
      return {
        ...state,
        selectedOffice: action.payload
      };
    case getType(setPopulationKey):
      return {
        ...state,
        populationKey: action.payload
      };
    default:
      return state as never;
  }
};

export default projectOptionsReducer;
