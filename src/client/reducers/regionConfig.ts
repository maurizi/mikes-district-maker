import { Cmd, Loop, loop } from "redux-loop";
import { getType } from "typesafe-actions";

import { LoopAction } from "../actions";
import {
  regionConfigsFetch,
  regionConfigsFetchFailure,
  regionConfigsFetchSuccess
} from "../actions/regionConfig";

import { IRegionConfig } from "../../shared/entities";
import { fetchRegionConfigs } from "../api";
import { showResourceFailedToast } from "../functions";
import { Resource } from "../resource";

export interface RegionConfigState {
  readonly regionConfigs: Resource<readonly IRegionConfig[]>;
}

export const initialState = {
  regionConfigs: { isPending: false }
};

const regionConfigReducer = (
  state: RegionConfigState = initialState,
  action: LoopAction
): RegionConfigState | Loop<RegionConfigState> => {
  switch (action.type) {
    case getType(regionConfigsFetch):
      return loop(
        {
          ...state,
          regionConfigs: { isPending: true }
        },
        Cmd.run(fetchRegionConfigs, {
          successActionCreator: regionConfigsFetchSuccess,
          failActionCreator: regionConfigsFetchFailure,
          args: [] as Parameters<typeof fetchRegionConfigs>
        })
      );
    case getType(regionConfigsFetchSuccess):
      return {
        ...state,
        regionConfigs: { resource: action.payload }
      };
    case getType(regionConfigsFetchFailure):
      return loop(
        {
          ...state,
          regionConfigs: {
            errorMessage: action.payload
          }
        },
        Cmd.run(showResourceFailedToast)
      );
    default:
      return state;
  }
};

export default regionConfigReducer;
