// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import React from "react";
import { Box } from "theme-ui";

const RegisterTermsText = () => (
  <Box sx={{ fontSize: 0, textAlign: "start", fontWeight: "normal" }}>
    By creating an account, you agree to the{" "}
    <a href="/terms" sx={{ color: "blue.5" }} target="_blank" rel="noopener noreferrer">
      Terms of Service
    </a>{" "}
    and{" "}
    <a href="/privacy" sx={{ color: "blue.5" }} target="_blank" rel="noopener noreferrer">
      Privacy Policy
    </a>
    . We will infrequently send you critical, account-related emails.
  </Box>
);

export default RegisterTermsText;
