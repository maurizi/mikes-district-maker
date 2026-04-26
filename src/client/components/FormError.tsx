// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import React from "react";
import { Box } from "theme-ui";

import { type WriteResource } from "./../resource";

export default function FormError({
  resource
}: {
  readonly resource: WriteResource<any, any>;
}): React.ReactElement | null {
  const errorMessage =
    "errors" in resource && typeof resource.errors.message === "string"
      ? resource.errors.message
      : undefined;
  return errorMessage ? (
    <Box
      sx={{
        px: 2,
        py: 1,
        mb: 1,
        borderRadius: "2px",
        backgroundColor: "warning",
        color: "#141414"
      }}
    >
      {errorMessage}
    </Box>
  ) : null;
}
