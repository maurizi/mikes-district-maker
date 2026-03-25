import { createStore, applyMiddleware } from "redux";
import { composeWithDevTools } from "@redux-devtools/extension";
import { install, StoreCreator } from "redux-loop";
import { getType } from "typesafe-actions";
import { redo, undo } from "./actions/districtDrawing";
import GTM from "./GTM";
import rootReducer, { initialState } from "./reducers";

// redux-loop requires casting createStore to its StoreCreator type
// which accepts LoopReducer and returns a store that handles Cmd effects
const enhancedCreateStore = createStore as StoreCreator;

const composeEnhancers = composeWithDevTools({
  actionSanitizer: action => {
    if (action.type === getType(undo) || action.type === getType(redo)) {
      return { ...action, payload: "map object" };
    } else {
      return action;
    }
  }
});

export default enhancedCreateStore(
  rootReducer,
  initialState,
  // @ts-expect-error @redux-devtools/extension types composeWithDevTools return as
  // StoreEnhancer<{ dispatch: unknown }> which is narrower than what redux-loop's
  // StoreCreator expects, but the enhancer composition is correct at runtime
  composeEnhancers(install(), applyMiddleware(GTM))
);
