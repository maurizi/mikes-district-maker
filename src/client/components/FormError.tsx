import React from "react";
import { Box } from "theme-ui";

import { WriteResource } from "./../resource";

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
      sx={{ px: 2, py: 1, mb: 1, borderRadius: "2px", backgroundColor: "warning", color: "white" }}
    >
      {errorMessage}
    </Box>
  ) : null;
}
