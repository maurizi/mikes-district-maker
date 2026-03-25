import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";

import App from "./client/App";
import "./client/index.css";
import store from "./client/store";

const root = createRoot(document.getElementById("root")!);
root.render(
  <Provider store={store}>
    <App />
  </Provider>
);
