import React from "react";
import { Box, Flex } from "theme-ui";

import ColorModeToggle from "./ColorModeToggle";

interface Props {
  readonly children?: React.ReactNode;
  // Auth screens want a color-mode toggle in the corner since they don't have
  // a SiteHeader. Transient uses like the project loading spinner pass
  // showToggle={false} so the toggle doesn't appear alongside a lone spinner.
  readonly showToggle?: boolean;
}

const CenteredContent = ({ children, showToggle = true }: Props) => {
  return (
    <Flex
      sx={{
        flexDirection: "column",
        py: 3,
        "@media screen and (min-height: 600px)": {
          mt: "0",
          height: "100vh"
        }
      }}
    >
      {showToggle && (
        <Box sx={{ position: "absolute", top: 2, right: 2, zIndex: 1 }}>
          <ColorModeToggle />
        </Box>
      )}
      <Flex as="main" sx={{ width: "100%", height: "100%" }}>
        <Flex
          sx={{
            width: "100%",
            maxWidth: "form",
            mx: "auto",
            flexDirection: "column",
            justifyContent: "center"
          }}
        >
          {children}
        </Flex>
      </Flex>
    </Flex>
  );
};

export default CenteredContent;
