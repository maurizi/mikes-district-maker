// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Button as MenuButton, Wrapper, Menu, MenuItem } from "react-aria-menubutton";
import Icon from "../components/Icon";
import { style, invertStyles } from "./MenuButton.styles";
import store from "../store";
import { toggleKeyboardShortcutsModal } from "../actions/projectModals";
import { SOURCE_CODE_URL } from "../constants/license";

enum UserMenuKeys {
  Contact = "contact",
  Guide = "guide",
  KeyboardShortcuts = "keyboardShortcuts",
  SourceCode = "sourceCode"
}

const guideLink =
  "https://github.com/PublicMapping/districtbuilder/wiki/Getting-Started-with-DistrictBuilder";

const contactLink = "mailto:michael@maurizi.org";

const showKeyboardShortcuts = () => store.dispatch(toggleKeyboardShortcutsModal());

interface StateProps {
  readonly project?: boolean;
}
interface SupportProps {
  readonly invert?: boolean;
}

const SupportMenu = ({ project, ...props }: SupportProps & StateProps) => {
  return (
    <Wrapper sx={{ position: "relative", pr: 1 }}>
      <MenuButton
        sx={{
          ...{ variant: "buttons.ghost", fontWeight: "light" },
          ...style.menuButton,
          ...invertStyles(props)
        }}
        className="support-menu"
      >
        <Icon name="question-circle" />
        Resources
      </MenuButton>
      <Menu sx={style.menu}>
        <ul sx={style.menuList}>
          <li key={UserMenuKeys.Guide}>
            <MenuItem value={UserMenuKeys.Guide}>
              <a href={guideLink} target="_blank" sx={style.menuListItem} rel="noreferrer">
                <Icon name="book-spells" sx={style.menuListIcon} />
                Getting Started Guide
              </a>
            </MenuItem>
          </li>
          <li key={UserMenuKeys.Contact}>
            <MenuItem value={UserMenuKeys.Contact}>
              <a href={contactLink} target="_blank" sx={style.menuListItem} rel="noreferrer">
                <Icon name="envelope" sx={style.menuListIcon} />
                Contact us
              </a>
            </MenuItem>
          </li>
          <li key={UserMenuKeys.SourceCode}>
            <MenuItem value={UserMenuKeys.SourceCode}>
              <a href={SOURCE_CODE_URL} target="_blank" sx={style.menuListItem} rel="noreferrer">
                <Icon name="link" sx={style.menuListIcon} />
                Source code
              </a>
            </MenuItem>
          </li>
          {project && (
            <li key={UserMenuKeys.KeyboardShortcuts}>
              <MenuItem value={UserMenuKeys.KeyboardShortcuts}>
                <a target="_blank" sx={style.menuListItem} onClick={showKeyboardShortcuts}>
                  <Icon name="keyboard" sx={style.menuListIcon} />
                  Show keyboard shortcuts
                </a>
              </MenuItem>
            </li>
          )}
        </ul>
      </Menu>
    </Wrapper>
  );
};

export default SupportMenu;
