/** @jsxImportSource theme-ui */
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

const TermsScreen = ({ user }: StateProps) => {
  useEffect(() => {
    document.title = "Mike's District Maker | Terms of Service";
  });
  useEffect(() => {
    isUserLoggedIn() && store.dispatch(userFetch());
  }, []);

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SiteHeader user={user} />
      <Box sx={{ maxWidth: "760px", mx: "auto", px: 4, py: 5, flex: 1 }}>
        <Heading as="h1" sx={{ mb: 2 }}>
          Terms of Service
        </Heading>
        <Text as="p" sx={{ color: "gray.6", mb: 4 }}>
          Last updated: April 14, 2026
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          1. About this service
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          Mike&rsquo;s District Maker (&ldquo;the Service&rdquo;, &ldquo;we&rdquo;,
          &ldquo;us&rdquo;) is a free, open-source web application for drawing electoral district
          maps. It is operated as a personal project by Michael Maurizi Jr and is a fork of the
          open-source{" "}
          <a href="https://github.com/PublicMapping/districtbuilder" rel="noreferrer noopener">
            DistrictBuilder
          </a>{" "}
          project originally developed by Azavea and Public Mapping. By creating an account or using
          the Service you agree to these terms.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          2. Free and as-is
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          The Service is provided free of charge on an &ldquo;as-is&rdquo; and
          &ldquo;as-available&rdquo; basis, without warranties of any kind, express or implied. We
          do not guarantee availability, accuracy of demographic data, absence of bugs, or fitness
          for any particular purpose. The maps you produce are your responsibility — verify anything
          that matters before relying on it.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          3. Your account and your maps
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          You are responsible for safeguarding your account credentials. You retain ownership of the
          maps and district plans you create. By publishing a map publicly on the Service, you grant
          other users the right to view, copy, and build upon it within the Service. You can delete
          your maps or your account at any time by emailing{" "}
          <a href="mailto:michael@maurizi.org">michael@maurizi.org</a>.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          4. Acceptable use
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          Don&rsquo;t use the Service to do anything illegal, to harass other users, to attempt to
          break the Service or gain unauthorized access, to scrape at volumes that affect other
          users, or to impersonate someone else. We may suspend or terminate accounts that do any of
          the above.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          5. Data sources and their terms
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          The Service relies on publicly-available data from a number of third parties. Some of
          those third parties impose conditions on how their data may be used, and by using the
          Service you agree to abide by those conditions:
        </Text>
        <Box as="ul" sx={{ mb: 3, pl: 4 }}>
          <Text as="li" sx={{ mb: 2 }}>
            <strong>Voting and Election Science Team (VEST).</strong> The primary source of precinct
            boundaries and precinct-level election results used on the Service. VEST data is
            published on{" "}
            <a
              href="https://dataverse.harvard.edu/dataverse/electionscience"
              rel="noreferrer noopener"
              target="_blank"
            >
              Harvard Dataverse
            </a>{" "}
            under a Creative Commons Attribution 4.0 (CC BY 4.0) license. Attribution to VEST is
            provided on our landing page. If you redistribute maps or derivatives that rely on VEST
            data, you are responsible for carrying the attribution forward.
          </Text>
          <Text as="li" sx={{ mb: 2 }}>
            <strong>Redistricting Data Hub (RDH).</strong> Supplemental precinct-level election /
            voting data (where VEST coverage is unavailable) is sourced from the nonpartisan{" "}
            <a href="https://redistrictingdatahub.org/" rel="noreferrer noopener" target="_blank">
              Redistricting Data Hub
            </a>
            . RDH data is provided for <strong>noncommercial and nonpartisan</strong> use only and{" "}
            <strong>may not be used for gerrymandering</strong>. Per RDH&rsquo;s{" "}
            <a
              href="https://redistrictingdatahub.org/terms-and-conditions/"
              rel="noreferrer noopener"
              target="_blank"
            >
              Terms and Conditions of Use
            </a>
            , &ldquo;gerrymandering&rdquo; means drawing a community of interest map, legislative
            district, or districting plan to favor or disfavor an incumbent, candidate, donor, or
            political party, or to deny racial or language minorities the equal opportunity to
            participate in the political process and elect representatives of their choice. By
            creating an account and using the Service you agree to use any RDH-sourced data only in
            a manner consistent with those terms.
          </Text>
          <Text as="li" sx={{ mb: 2 }}>
            <strong>UF Election Lab.</strong> Ongoing election data research from the University of
            Florida Election Lab (
            <a href="https://election.lab.ufl.edu/" rel="noreferrer noopener" target="_blank">
              election.lab.ufl.edu
            </a>
            ).
          </Text>
          <Text as="li" sx={{ mb: 2 }}>
            <strong>US Census Bureau.</strong> TIGER/Line geographies and Decennial Census &amp; ACS
            demographic data, which are public-domain US federal government works.
          </Text>
          <Text as="li" sx={{ mb: 2 }}>
            <strong>OpenStreetMap.</strong> Basemap data{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              rel="noreferrer noopener"
              target="_blank"
            >
              © OpenStreetMap contributors
            </a>
            , used under the Open Database License (ODbL).
          </Text>
          <Text as="li" sx={{ mb: 2 }}>
            <strong>Protomaps.</strong> Open-source vector basemap tiles from{" "}
            <a href="https://protomaps.com" rel="noreferrer noopener" target="_blank">
              protomaps.com
            </a>
            .
          </Text>
        </Box>
        <Text as="p" sx={{ mb: 3 }}>
          The Service is not affiliated with, sponsored by, or endorsed by any of the above
          organizations. If you believe a map drawn on this Service violates any of these terms,
          please contact us at <a href="mailto:michael@maurizi.org">michael@maurizi.org</a> and we
          will investigate.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          6. Limitation of liability
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          To the fullest extent permitted by law, Michael Maurizi Jr will not be liable for any
          indirect, incidental, special, consequential, or punitive damages arising out of your use
          of the Service.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          7. Changes
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          These terms may be updated from time to time. Material changes will be announced on the
          homepage. Continued use of the Service after changes take effect constitutes acceptance of
          the new terms.
        </Text>

        <Heading as="h2" sx={{ mt: 4, mb: 2 }}>
          8. Contact
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          Questions? Email <a href="mailto:michael@maurizi.org">michael@maurizi.org</a>.
        </Text>
      </Box>
    </Box>
  );
};

function mapStateToProps(state: State): StateProps {
  return { user: state.user };
}

export default connect(mapStateToProps)(TermsScreen);
