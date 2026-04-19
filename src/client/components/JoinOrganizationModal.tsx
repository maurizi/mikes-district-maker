// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import AriaModal from "react-aria-modal";
import { connect } from "react-redux";

import { Box, type ThemeUIStyleObject } from "theme-ui";

import { type IOrganization, type IUser } from "../../shared/entities";
import { showCopyMapModal } from "../actions/projectModals";
import { type State } from "../reducers";
import store from "../store";
import { AuthModalContent } from "./AuthComponents";
import ConfirmJoinOrganization from "./ConfirmJoinOrganization";
import { type Resource } from "../resource";
import { type CreateProjectData } from "../../shared/entities";

const style: Record<string, ThemeUIStyleObject> = {
  footer: {
    display: "flex",
    flexDirection: "column",
    marginTop: 5
  },
  header: {
    mb: 5
  },
  heading: {
    fontFamily: "heading",
    fontWeight: "light",
    fontSize: 4
  },
  modal: {
    bg: "muted",
    p: 5,
    width: "small",
    maxWidth: "90vw",
    overflow: "visible"
  }
};

const JoinOrganizationModal = ({
  organization,
  user,
  showModal,
  projectTemplateData,
  onCancel
}: {
  readonly organization: IOrganization;
  readonly showModal: boolean;
  readonly user: Resource<IUser>;
  readonly projectTemplateData?: CreateProjectData;
  readonly onCancel: () => void;
}) => {
  const hideModal = () => {
    onCancel();
    store.dispatch(showCopyMapModal(false));
  };

  return showModal ? (
    <AriaModal
      titleId="copy-map-modal-header"
      onExit={hideModal}
      initialFocus="#primary-action"
      getApplicationNode={() => document.getElementById("root") as Element}
      underlayStyle={{ paddingTop: "4.5rem" }}
    >
      <Box sx={style.modal}>
        {"resource" in user ? (
          <ConfirmJoinOrganization
            organization={organization}
            projectTemplateData={projectTemplateData}
            onCancel={onCancel}
          />
        ) : (
          <AuthModalContent organization={organization} />
        )}
      </Box>
    </AriaModal>
  ) : null;
};

function mapStateToProps(state: State) {
  return {
    showModal: state.projectModals.showCopyMapModal,
    user: state.user
  };
}

export default connect(mapStateToProps)(JoinOrganizationModal);
