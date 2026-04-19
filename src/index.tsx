// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";

import "./client/rum";
import App from "./client/App";
import "./client/index.css";
import store from "./client/store";

const root = createRoot(document.getElementById("root")!);
root.render(
  <Provider store={store}>
    <App />
  </Provider>
);
