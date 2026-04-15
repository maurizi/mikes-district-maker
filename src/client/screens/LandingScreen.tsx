/** @jsxImportSource theme-ui */
import React, { useEffect } from "react";
import { connect } from "react-redux";
import { Link } from "react-router-dom";
import { Box, Button, Flex, Heading, Text, type ThemeUIStyleObject } from "theme-ui";

import SiteHeader from "../components/SiteHeader";
import Logo from "../media/logos/logo.svg?react";
import Mark from "../media/logos/mark.svg?react";
import MakingMapsIllustration from "../media/making-maps.svg?react";
import FairDistrictsIllustration from "../media/fair-districts.svg?react";
import shotOverview from "../media/landing/florida-full-size.png";
import shotBlocks from "../media/landing/block-level-demographics.png";
import shotCompetitiveness from "../media/landing/competitiveness.png";
import { type State } from "../reducers";
import { type UserState } from "../reducers/user";
import store from "../store";
import { userFetch } from "../actions/user";
import { isUserLoggedIn } from "../jwt";

interface StateProps {
  readonly user: UserState;
}

const style: Record<string, ThemeUIStyleObject> = {
  hero: {
    bg: "#FBF5E4",
    py: 6,
    px: 4,
    textAlign: "center",
    borderTop: "1px solid",
    borderBottom: "1px solid",
    borderColor: "gray.2",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6)"
  },
  heroInner: {
    maxWidth: "900px",
    mx: "auto"
  },
  tagline: {
    fontSize: 3,
    color: "gray.7",
    mt: 3,
    mb: 4,
    lineHeight: "1.5"
  },
  ctaRow: {
    gap: 3,
    justifyContent: "center",
    flexWrap: "wrap"
  },
  section: {
    maxWidth: "1040px",
    mx: "auto",
    px: 4,
    py: 5
  },
  sectionHeading: {
    mb: 4,
    textAlign: "center"
  },
  shotsGrid: {
    display: "grid",
    gridTemplateColumns: ["1fr", "1fr", "repeat(3, 1fr)"],
    gap: 3,
    maxWidth: "1320px",
    mx: "auto"
  },
  shotCard: {
    bg: "muted",
    borderRadius: "medium",
    overflow: "hidden",
    border: "1px solid",
    borderColor: "gray.2",
    boxShadow: "small",
    p: 0
  },
  shotImage: {
    display: "block",
    width: "100%",
    height: "auto",
    aspectRatio: "1722 / 968",
    bg: "gray.1"
  },
  shotCaption: {
    p: 3,
    fontSize: 1,
    color: "gray.7"
  },
  partnersGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 3,
    mt: 3
  },
  partnerCard: {
    p: 3,
    bg: "muted",
    borderRadius: "medium",
    border: "1px solid",
    borderColor: "gray.2"
  },
  lineageBox: {
    bg: "gray.0",
    borderLeft: "4px solid",
    borderColor: "blue.5",
    p: 4,
    my: 4,
    borderRadius: "small"
  },
  footer: {
    bg: "gray.1",
    py: 5,
    px: 4,
    mt: 5,
    borderTop: "1px solid",
    borderColor: "gray.2"
  },
  footerInner: {
    maxWidth: "1040px",
    mx: "auto",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 4
  },
  footerHeading: {
    fontSize: 1,
    textTransform: "uppercase",
    letterSpacing: "1px",
    color: "gray.7",
    mb: 2
  },
  footerLink: {
    display: "block",
    color: "gray.8",
    textDecoration: "none",
    py: 1,
    "&:hover": { color: "blue.5" }
  }
};

const ShotCard = ({
  src,
  alt,
  caption
}: {
  readonly src: string;
  readonly alt: string;
  readonly caption: React.ReactNode;
}) => (
  <Box sx={style.shotCard}>
    <img src={src} alt={alt} sx={style.shotImage} />
    <Box sx={style.shotCaption}>{caption}</Box>
  </Box>
);

const LandingScreen = ({ user }: StateProps) => {
  const loggedIn = isUserLoggedIn();
  useEffect(() => {
    document.title = "Mike's District Maker";
  });
  useEffect(() => {
    loggedIn && store.dispatch(userFetch());
  }, [loggedIn]);

  const primaryCtaTo = loggedIn ? "/create-project" : "/register";
  const primaryCtaLabel = loggedIn ? "Start a new map" : "Sign up and start drawing";

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SiteHeader user={user} />

      <Box as="section" sx={style.hero}>
        <Flex
          sx={{
            ...style.heroInner,
            flexDirection: ["column", "column", "row"],
            alignItems: "center",
            gap: [4, 4, 5],
            textAlign: ["center", "center", "left"]
          }}
        >
          <Box sx={{ flex: "1 1 0", minWidth: 0 }}>
            <Logo
              sx={{ width: "min(420px, 80vw)", mb: 4, display: "block", mx: ["auto", "auto", 0] }}
            />
            <Heading as="h1" sx={{ variant: "text.h1", mb: 2 }}>
              Draw electoral district maps that reflect your community.
            </Heading>
            <Text as="p" sx={style.tagline}>
              Mike&rsquo;s District Maker is a free, open-source redistricting tool. Pick a state,
              group census geographies into districts, and share what you build.
            </Text>
            <Flex sx={{ ...style.ctaRow, justifyContent: ["center", "center", "flex-start"] }}>
              <Link to={primaryCtaTo} sx={{ textDecoration: "none" }}>
                <Button sx={{ variant: "buttons.primary" }}>{primaryCtaLabel}</Button>
              </Link>
              <Link to="/maps" sx={{ textDecoration: "none" }}>
                <Button sx={{ variant: "buttons.secondary" }}>Browse community maps</Button>
              </Link>
            </Flex>
          </Box>
          <Box sx={{ flex: "1 1 0", minWidth: 0, maxWidth: "560px" }}>
            <MakingMapsIllustration sx={{ width: "100%", height: "auto" }} />
          </Box>
        </Flex>
      </Box>

      <Box as="section" sx={{ ...style.section, maxWidth: "1320px" }}>
        <Heading as="h2" sx={style.sectionHeading}>
          What it looks like
        </Heading>
        <Box sx={style.shotsGrid}>
          <ShotCard
            src={shotOverview}
            alt="A completed Florida district plan"
            caption={
              <>
                <strong>Draw a whole state.</strong> Group counties, precincts, or census blocks
                into districts. Live population and deviation stats update as you work.
              </>
            }
          />
          <ShotCard
            src={shotBlocks}
            alt="Zoomed-in block-level view with a demographic tooltip"
            caption={
              <>
                <strong>Zoom to census blocks.</strong> Drill all the way down for block-level
                precision, with per-block demographic breakdowns on hover.
              </>
            }
          />
          <ShotCard
            src={shotCompetitiveness}
            alt="Competitiveness analysis panel for a Virginia plan"
            caption={
              <>
                <strong>Analyze the politics.</strong> Evaluate partisan lean and competitiveness
                using PVI, with per-district election history from VEST alongside demographics.
              </>
            }
          />
        </Box>
      </Box>

      <Box as="section" sx={{ ...style.section, bg: "gray.0", maxWidth: "none", px: 4 }}>
        <Flex
          sx={{
            maxWidth: "1040px",
            mx: "auto",
            flexDirection: ["column", "column", "row-reverse"],
            alignItems: "center",
            gap: [4, 4, 5]
          }}
        >
          <Box sx={{ flex: "1 1 0", minWidth: 0, maxWidth: "480px" }}>
            <FairDistrictsIllustration sx={{ width: "100%", height: "auto" }} />
          </Box>
          <Box sx={{ flex: "1 1 0", minWidth: 0, textAlign: ["center", "center", "left"] }}>
            <Heading as="h2" sx={{ ...style.sectionHeading, textAlign: "inherit" }}>
              Explore maps drawn by the community
            </Heading>
            <Text as="p" sx={{ color: "gray.7", mb: 4 }}>
              People across the country have published their own district plans. Browse them by
              state, copy them as a starting point, or draw your own from scratch.
            </Text>
            <Flex sx={{ justifyContent: ["center", "center", "flex-start"] }}>
              <Link to="/maps" sx={{ textDecoration: "none" }}>
                <Button sx={{ variant: "buttons.primary" }}>View community maps</Button>
              </Link>
            </Flex>
          </Box>
        </Flex>
      </Box>

      <Box as="section" sx={style.section}>
        <Heading as="h2" sx={style.sectionHeading}>
          Data partners &amp; credits
        </Heading>
        <Text as="p" sx={{ textAlign: "center", color: "gray.7" }}>
          This project stands on the shoulders of publicly-available data, open-source tools, and
          the volunteers and researchers who collect and maintain the underlying datasets.
        </Text>
        <Box sx={style.partnersGrid}>
          <Box sx={style.partnerCard}>
            <Heading as="h3" sx={{ fontSize: 2, mb: 1 }}>
              US Census Bureau
            </Heading>
            <Text sx={{ fontSize: 1, color: "gray.7" }}>
              TIGER/Line geography and Decennial Census &amp; ACS demographic data.
            </Text>
          </Box>
          <Box sx={style.partnerCard}>
            <Heading as="h3" sx={{ fontSize: 2, mb: 1 }}>
              Voting and Election Science Team (VEST)
            </Heading>
            <Text sx={{ fontSize: 1, color: "gray.7" }}>
              The primary source of precinct boundaries and election results used on this site.
              Compiled by Michael McDonald and Brian Amos at the{" "}
              <a href="https://election.lab.ufl.edu/" rel="noreferrer noopener" target="_blank">
                University of Florida Election Lab
              </a>{" "}
              and published on{" "}
              <a
                href="https://dataverse.harvard.edu/dataverse/electionscience"
                rel="noreferrer noopener"
                target="_blank"
              >
                Harvard Dataverse
              </a>{" "}
              under a Creative Commons Attribution (CC BY 4.0) license.
            </Text>
          </Box>
          <Box sx={style.partnerCard}>
            <Heading as="h3" sx={{ fontSize: 2, mb: 1 }}>
              Redistricting Data Hub
            </Heading>
            <Text sx={{ fontSize: 1, color: "gray.7" }}>
              Supplemental election / voting data for states and years not covered by VEST, from the{" "}
              <a href="https://redistrictingdatahub.org/" rel="noreferrer noopener" target="_blank">
                nonpartisan Redistricting Data Hub
              </a>
              . RDH data is used under their{" "}
              <a
                href="https://redistrictingdatahub.org/terms-and-conditions/"
                rel="noreferrer noopener"
                target="_blank"
              >
                terms and conditions
              </a>{" "}
              — noncommercial and nonpartisan use only, no gerrymandering. Thanks in particular to{" "}
              <strong>Ben Rosenblatt</strong>, whose New York precinct-level election data is
              distributed through RDH.
            </Text>
          </Box>
          <Box sx={style.partnerCard}>
            <Heading as="h3" sx={{ fontSize: 2, mb: 1 }}>
              OpenStreetMap
            </Heading>
            <Text sx={{ fontSize: 1, color: "gray.7" }}>
              Basemap data contributed by volunteers around the world.{" "}
              <a
                href="https://www.openstreetmap.org/copyright"
                rel="noreferrer noopener"
                target="_blank"
              >
                © OpenStreetMap contributors
              </a>
              .
            </Text>
          </Box>
        </Box>

        <Heading as="h3" sx={{ ...style.sectionHeading, fontSize: 3, mt: 5, mb: 3 }}>
          Open-source software
        </Heading>
        <Box sx={style.partnersGrid}>
          <Box sx={style.partnerCard}>
            <Heading as="h3" sx={{ fontSize: 2, mb: 1 }}>
              Protomaps
            </Heading>
            <Text sx={{ fontSize: 1, color: "gray.7" }}>
              Open-source vector basemap tiles.{" "}
              <a href="https://protomaps.com" rel="noreferrer noopener" target="_blank">
                protomaps.com
              </a>
              .
            </Text>
          </Box>
          <Box sx={style.partnerCard}>
            <Heading as="h3" sx={{ fontSize: 2, mb: 1 }}>
              MapLibre GL
            </Heading>
            <Text sx={{ fontSize: 1, color: "gray.7" }}>
              Open-source library powering interactive map rendering in the browser.
            </Text>
          </Box>
        </Box>

        <Box
          sx={{
            ...style.lineageBox,
            borderColor: "#c05621",
            bg: "#fff7ed"
          }}
        >
          <Heading as="h3" sx={{ fontSize: 3, mb: 2 }}>
            How you can use this site
          </Heading>
          <Text as="p" sx={{ color: "gray.8", mb: 2 }}>
            Some of the data that powers Mike&rsquo;s District Maker is provided under terms that
            restrict how it can be used. In particular, data sourced from the Redistricting Data Hub
            may only be used for <strong>noncommercial, nonpartisan</strong> purposes and{" "}
            <strong>not for gerrymandering</strong> — that is, not to draw maps that favor or
            disfavor an incumbent, candidate, donor, or political party, and not to dilute the
            voting power of racial or language minorities.
          </Text>
          <Text as="p" sx={{ color: "gray.8" }}>
            By creating an account and using this site, you agree to follow those terms. Full
            details are in the{" "}
            <Link to="/terms" sx={{ color: "blue.5" }}>
              Terms of Service
            </Link>
            .
          </Text>
        </Box>

        <Box sx={style.lineageBox}>
          <Heading as="h3" sx={{ fontSize: 3, mb: 2 }}>
            Built on DistrictBuilder
          </Heading>
          <Text as="p" sx={{ color: "gray.8", mb: 2 }}>
            Mike&rsquo;s District Maker is an independent fork of the open-source{" "}
            <a
              href="https://github.com/PublicMapping/districtbuilder"
              rel="noreferrer noopener"
              target="_blank"
            >
              DistrictBuilder
            </a>{" "}
            project originally developed by{" "}
            <a href="https://www.azavea.com" rel="noreferrer noopener" target="_blank">
              Azavea
            </a>{" "}
            and the Public Mapping Project.
          </Text>
          <Text as="p" sx={{ color: "gray.8" }}>
            Mike&rsquo;s District Maker is an independent personal fork of the original
            DistrictBuilder project, maintained by one of it&apos;s original core contributors; it
            is not affiliated with, supported by, or endorsed by Azavea or Public Mapping. Enormous
            thanks to the original team for building and open-sourcing the code this site is based
            on.
          </Text>
        </Box>
      </Box>

      <Box as="footer" sx={style.footer}>
        <Box sx={style.footerInner}>
          <Box>
            <Mark sx={{ width: "56px", mb: 2 }} />
            <Text sx={{ fontSize: 1, color: "gray.7" }}>
              © 2026 Michael Maurizi Jr. Built on the open-source DistrictBuilder project.
            </Text>
          </Box>
          <Box>
            <Heading as="h4" sx={style.footerHeading}>
              Product
            </Heading>
            <Link to="/maps" sx={style.footerLink}>
              Community maps
            </Link>
            {loggedIn ? (
              <Link to="/create-project" sx={style.footerLink}>
                Start a new map
              </Link>
            ) : (
              <Link to="/register" sx={style.footerLink}>
                Sign up
              </Link>
            )}
            {!loggedIn && (
              <Link to="/login" sx={style.footerLink}>
                Log in
              </Link>
            )}
          </Box>
          <Box>
            <Heading as="h4" sx={style.footerHeading}>
              Legal
            </Heading>
            <Link to="/terms" sx={style.footerLink}>
              Terms of Service
            </Link>
            <Link to="/privacy" sx={style.footerLink}>
              Privacy Policy
            </Link>
          </Box>
          <Box>
            <Heading as="h4" sx={style.footerHeading}>
              Project
            </Heading>
            <a
              href="mailto:michael@maurizi.org"
              sx={style.footerLink as unknown as ThemeUIStyleObject}
            >
              Contact
            </a>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

function mapStateToProps(state: State): StateProps {
  return { user: state.user };
}

export default connect(mapStateToProps)(LandingScreen);
