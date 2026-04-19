// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { useColorMode, type ThemeUIStyleObject } from "theme-ui";

import Logo from "../media/logos/logo.svg?react";
import LogoWhite from "../media/logos/logo-white.svg?react";

interface Props {
  readonly sx?: ThemeUIStyleObject;
  readonly className?: string;
}

const SiteLogo = ({ sx, className }: Props) => {
  const [colorMode] = useColorMode();
  const LogoComponent = colorMode === "dark" ? LogoWhite : Logo;
  return <LogoComponent sx={sx} className={className} />;
};

export default SiteLogo;
