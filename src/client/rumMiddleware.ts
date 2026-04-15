import { type Middleware } from "redux";
import { getType } from "typesafe-actions";
import { updateDistrictsDefinition, projectFetch } from "./actions/projectData";
import { userProjectsFetch } from "./actions/projects";
import { regionConfigsFetch } from "./actions/regionConfig";
import { awsRum } from "./rum";

// To track additional actions, add them to this list and they will
// automatically be forwarded to CloudWatch RUM as custom events.
const trackingActionTypes = new Set<string>([
  getType(projectFetch), // user loaded a project
  getType(userProjectsFetch), // user loaded the home page
  getType(regionConfigsFetch), // user loaded the create project screen
  getType(updateDistrictsDefinition) // user saved a district
]);

const rumMiddleware: Middleware = () => next => action => {
  if (awsRum && action && typeof action.type === "string" && trackingActionTypes.has(action.type)) {
    awsRum.recordEvent(action.type, { payload: action.payload });
  }
  return next(action) as unknown;
};

export default rumMiddleware;
