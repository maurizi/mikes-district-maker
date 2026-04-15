import React, { useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { connect } from "react-redux";
import { Alert, Box, Card, Close, Flex, Heading } from "theme-ui";
import Logo from "../media/logos/logo.svg?react";

import { isUserLoggedIn } from "../jwt";
import RegisterContent from "../components/RegisterContent";
import CenteredContent from "../components/CenteredContent";
import { type IUser } from "../../shared/entities";
import { type State } from "../reducers";
import { type AuthLocationState } from "../types";
import { type Resource } from "../resource";
import RegisterTermsText from "../components/RegisterTermsText";

interface StateProps {
  readonly user: Resource<IUser>;
}

const RegistrationScreen = ({ user }: StateProps) => {
  const isLoggedIn = "resource" in user && isUserLoggedIn();
  const location = useLocation();
  const locationState = location.state as AuthLocationState | undefined;
  const to = locationState?.from || { pathname: "/" };
  const toParams = new URLSearchParams(to.search);
  const [showStartProjectAlert, setShowStartProjectAlert] = useState(
    to.pathname === "/start-project" && toParams.has("name")
  );

  return (
    <CenteredContent>
      {isLoggedIn ? (
        <Navigate to={to} replace />
      ) : (
        <React.Fragment>
          <Heading as="h1" sx={{ textAlign: "center" }}>
            <Logo sx={{ maxWidth: "15rem" }} />
          </Heading>
          <Card sx={{ variant: "cards.floating" }}>
            <RegisterContent>
              <Heading as="h2" sx={{ mb: 5, textAlign: "left" }}>
                Create an account!
              </Heading>
              {showStartProjectAlert && (
                <Alert sx={{ mb: 3 }}>
                  <Flex>
                    <Box>
                      Create an account or{" "}
                      <Link
                        sx={{ variant: "links.alert" }}
                        to={{ pathname: "/login" }}
                        state={location.state}
                      >
                        log in
                      </Link>{" "}
                      to create your &ldquo;{toParams.get("name")}&rdquo; map.
                    </Box>
                    <Close
                      as="a"
                      onClick={() => setShowStartProjectAlert(false)}
                      sx={{ ml: "auto", p: 0 }}
                    />
                  </Flex>
                </Alert>
              )}
            </RegisterContent>
          </Card>
          <RegisterTermsText />
        </React.Fragment>
      )}
    </CenteredContent>
  );
};

function mapStateToProps(state: State) {
  return {
    user: state.user
  };
}

export default connect(mapStateToProps)(RegistrationScreen);
