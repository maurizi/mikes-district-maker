import { Button as MenuButton, Wrapper, Menu, MenuItem } from "react-aria-menubutton";
import { invertStyles, style } from "./MenuButton.styles";
import { type OrganizationNest } from "../../shared/entities";
import { useNavigate, type NavigateFunction } from "react-router-dom";

interface Props {
  readonly organizations: readonly OrganizationNest[];
}

const OrganizationDropdown = ({ organizations }: Props) => {
  const navigate = useNavigate();
  return (
    <Wrapper sx={{ position: "relative" }} onSelection={handleSelection(navigate)}>
      <MenuButton
        sx={{
          ...{ variant: "buttons.ghost", fontWeight: "light" },
          ...style.menuButton,
          ...invertStyles({ invert: true }),
          ...{ color: "heading" }
        }}
        className="organization-menu"
      >
        My Organizations
      </MenuButton>
      <Menu sx={style.menu}>
        <ul sx={style.menuList}>
          {organizations.map(o => (
            <li key={o.slug}>
              <MenuItem value={o.slug} sx={style.menuListItem}>
                {o.name}
              </MenuItem>
            </li>
          ))}
        </ul>
      </Menu>
    </Wrapper>
  );
};

const handleSelection = (navigate: NavigateFunction) => (slug: string) => {
  navigate(`/o/${slug}`);
};

export default OrganizationDropdown;
