// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Box, Flex, Spinner, Card, Text } from "theme-ui";
import SiteLogo from "../components/SiteLogo";
import SuccessIllustration from "../media/successfully-registered-illustration.svg?react";

import { activateAccount } from "../api";
import { isUserLoggedIn } from "../jwt";
import CenteredContent from "../components/CenteredContent";
import { type Resource } from "../resource";

const ActivateAccountScreen = () => {
  const { token, organizationSlug } = useParams();
  const isLoggedIn = isUserLoggedIn();
  const [activationResource, setActivationResource] = useState<Resource<void>>({
    isPending: false
  });
  useEffect(() => {
    if (token !== undefined) {
      setActivationResource({ isPending: true });
      organizationSlug
        ? activateAccount(token)
            .then(() => {
              setActivationResource({ resource: void 0 });
            })
            .catch(errorMessage => setActivationResource({ errorMessage }))
        : activateAccount(token)
            .then(() => setActivationResource({ resource: void 0 }))
            .catch(errorMessage => setActivationResource({ errorMessage }));
    }
  }, [token, organizationSlug]);
  return (
    <CenteredContent>
      {"resource" in activationResource ? (
        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <SiteLogo sx={{ width: "15rem", mx: "auto", mb: 4 }} />
          <Card
            sx={{
              variant: "cards.floating",
              display: "flex",
              flexDirection: "column",
              justifyContent: "stretch"
            }}
          >
            <Box sx={{ mb: 3, mx: "auto" }}>
              <SuccessIllustration />
            </Box>
            <Text
              as="p"
              sx={{
                variant: "styles.header.title",
                textAlign: "center",
                fontSize: 3,
                mb: 4
              }}
            >
              Thank you for activating your account!
            </Text>

            <Link
              to={!isLoggedIn ? "/login" : organizationSlug ? `/o/${organizationSlug}` : "/"}
              state={
                !isLoggedIn && organizationSlug ? { from: `/o/${organizationSlug}` } : undefined
              }
              sx={{ variant: "linkButton" }}
            >
              {!isLoggedIn ? "Log in" : "Start mapping!"}
            </Link>
          </Card>
        </Box>
      ) : "errorMessage" in activationResource ? (
        <Box style={{ color: "red" }}>{activationResource.errorMessage}</Box>
      ) : "isPending" in activationResource && activationResource.isPending ? (
        <Flex sx={{ justifyContent: "center" }}>
          <Spinner variant="styles.spinner.large" />
        </Flex>
      ) : null}
    </CenteredContent>
  );
};

export default ActivateAccountScreen;
