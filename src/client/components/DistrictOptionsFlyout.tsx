import { Button } from "theme-ui";
import { type DistrictId } from "../../shared/entities";
import store from "../store";
import { setZoomToDistrictId } from "../actions/districtDrawing";
import Icon from "./Icon";

import { Menu, MenuItem } from "@szhsin/react-menu";
import "@szhsin/react-menu/dist/index.css";

const DistrictOptionsFlyout = ({
  districtId,
  isDistrictHovered
}: {
  readonly districtId: DistrictId;
  readonly isDistrictHovered: boolean;
}) => {
  return (
    <Menu
      viewScroll="close"
      gap={30}
      menuButton={
        <Button
          sx={{
            mr: 2,
            "@media (hover: hover)": {
              visibility: isDistrictHovered ? "visible" : "hidden"
            }
          }}
          variant="icon"
        >
          <Icon name="ellipsis" color="#131f28" size={0.75} />
        </Button>
      }
    >
      <MenuItem
        style={{
          fontSize: "14px"
        }}
        onClick={() => {
          store.dispatch(setZoomToDistrictId(districtId));
        }}
      >
        Zoom to District
      </MenuItem>
    </Menu>
  );
};

export default DistrictOptionsFlyout;
