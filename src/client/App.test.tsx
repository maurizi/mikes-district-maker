// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { describe, it } from "vitest";

import App from "./App";
import store from "./store";

describe("App", () => {
  it("renders without crashing", () => {
    const div = document.createElement("div");
    const root = createRoot(div);
    root.render(
      <Provider store={store}>
        <App />
      </Provider>
    );
    root.unmount();
  });
});
