// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import React, { useEffect } from "react";
import { connect } from "react-redux";
import { Box, Heading, Text } from "theme-ui";
import SiteHeader from "../components/SiteHeader";
import { type State } from "../reducers";
import { type UserState } from "../reducers/user";
import store from "../store";
import { userFetch } from "../actions/user";
import { isUserLoggedIn } from "../jwt";

interface StateProps {
  readonly user: UserState;
}

const PrivacyScreen = ({ user }: StateProps) => {
  useEffect(() => {
    document.title = "Mike's District Maker | Privacy Policy";
  });
  useEffect(() => {
    isUserLoggedIn() && store.dispatch(userFetch());
  }, []);

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SiteHeader user={user} />
      <Box sx={{ maxWidth: "760px", mx: "auto", px: 4, py: 5, flex: 1 }}>
        <Heading as="h1" sx={{ mb: 2 }}>
          Privacy Policy
        </Heading>
        <Text as="p" sx={{ color: "gray.6", mb: 4 }}>
          Last updated: April 14, 2026
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          Plain-language summary
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          Mike&rsquo;s District Maker is a personal, open-source project. We collect the minimum
          information needed to run the site: your account details, the maps you create, and basic
          page-view analytics. We do not sell your data, we do not run advertising, and we do not
          share your information with third parties except as described below.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          What we collect
        </Heading>
        <Text as="p" sx={{ mb: 2 }}>
          <strong>Account data:</strong> your name, email address, and hashed password when you
          register. You can opt in to occasional product update emails; you can turn this off at any
          time in your account settings.
        </Text>
        <Text as="p" sx={{ mb: 2 }}>
          <strong>Map data:</strong> the district plans you create, their visibility setting
          (private, shared by link, or published), and associated metadata. Published maps are
          visible to anyone who visits the Community Maps page.
        </Text>
        <Text as="p" sx={{ mb: 3 }}>
          <strong>Usage analytics:</strong> we use Amazon CloudWatch RUM to collect pseudonymous
          page-view, performance, and error data. This helps us find bugs and understand which
          features are used. It does not build an advertising profile and is not shared with
          marketers.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          Cookies
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          We use a single session token (stored in your browser) to keep you logged in. We do not
          use third-party tracking or advertising cookies.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          Who processes your data
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          The Service runs on Amazon Web Services. AWS processes data on our behalf as a service
          provider. We do not otherwise share personal data with third parties. Transactional email
          (account verification, password reset) is sent via AWS SES.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          Your rights
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          You can view, update, export, or delete your account data at any time by emailing{" "}
          <a href="mailto:michael@maurizi.org">michael@maurizi.org</a>. If you are in the EU, UK, or
          California, you have rights under GDPR / CCPA including access, correction, deletion, and
          the right to object to processing. Email us to exercise any of these rights — we aim to
          respond within 30 days.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          Children
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          The Service is not directed at children under 13 and we do not knowingly collect personal
          information from them.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          Contact
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          Privacy questions or requests:{" "}
          <a href="mailto:michael@maurizi.org">michael@maurizi.org</a>.
        </Text>
      </Box>
    </Box>
  );
};

function mapStateToProps(state: State): StateProps {
  return { user: state.user };
}

export default connect(mapStateToProps)(PrivacyScreen);
