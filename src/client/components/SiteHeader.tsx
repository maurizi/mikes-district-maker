import { Button as MenuButton, Wrapper, Menu, MenuItem } from "react-aria-menubutton";
import Avatar from "react-avatar";
import React, { useState } from "react";
import { Link, NavLink, useNavigate, type NavigateFunction } from "react-router-dom";
import Icon from "../components/Icon";
import SupportMenu from "../components/SupportMenu";
import OrganizationDropdown from "../components/OrganizationDropdown";
import { Alert, Box, Button, Flex, Heading, type ThemeUIStyleObject } from "theme-ui";

import Logo from "../media/logos/logo.svg?react";

import { resetState } from "../actions/root";
import { clearJWT, isUserLoggedIn } from "../jwt";
import { type UserState } from "../reducers/user";
import store from "../store";
import { resendConfirmationEmail } from "../api";
import { type WriteResource } from "../resource";
import useIsMobile from "../hooks/useIsMobile";

interface Props {
  readonly user: UserState;
}

enum UserMenuKeys {
  MyMaps = "my-maps",
  CommunityMaps = "community-maps",
  Account = "account",
  Logout = "logout"
}

const logout = () => {
  clearJWT();
  store.dispatch(resetState());
};

const style: Record<string, ThemeUIStyleObject> = {
  header: {
    alignItems: "center",
    justifyContent: "space-between",
    py: 3,
    px: 3,
    bg: "gray.0",
    borderBottom: "1px solid",
    borderColor: "gray.1",
    boxShadow: "small"
  },
  logoLink: {
    borderRadius: "small",
    "&:focus": {
      outline: "none",
      boxShadow: "focus"
    }
  },
  avatar: {
    fontFamily: "heading",
    cursor: "pointer",
    ".sb-avatar__text": {
      "&:hover": {
        backgroundColor: "#395c78 !important"
      },
      "&:active": {
        backgroundColor: "#2c485e !important"
      }
    }
  },
  menuButton: {
    display: "flex",
    alignItems: "center",
    bg: "transparent",
    p: 1,
    borderRadius: "small",
    "&:focus": {
      outline: "none",
      boxShadow: "focus"
    }
  },
  menu: {
    width: "150px",
    position: "absolute",
    mt: 2,
    right: 2,
    bg: "muted",
    py: 1,
    px: 1,
    border: "1px solid",
    borderColor: "gray.2",
    boxShadow: "small",
    borderRadius: "small",
    zIndex: 500
  },
  menuList: {
    p: "0",
    m: "0",
    listStyleType: "none"
  },
  linkItem: {
    px: "3",
    py: 1,
    display: "inline-block",
    a: {
      textDecoration: "none",
      fontWeight: "light",
      fontFamily: "heading",
      color: "gray.8"
    },
    "> .active": {
      borderBottom: "2px solid currentColor",
      paddingBottom: "4px",
      fontWeight: "medium"
    }
  },
  menuListItem: {
    borderRadius: "small",
    py: 1,
    px: 2,
    "&:hover:not([disabled])": {
      bg: "gray.0",
      cursor: "pointer"
    },
    "&[disabled]": {
      color: "gray.3",
      cursor: "not-allowed"
    },
    "&:focus": {
      bg: "gray.0",
      outline: "none",
      boxShadow: "focus"
    },
    "&:active": {
      bg: "gray.1"
    }
  }
};

const SiteHeader = ({ user }: Props) => {
  const navigate = useNavigate();
  const isLoggedIn = isUserLoggedIn();
  const isMobile = useIsMobile();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [resendEmail, setResendEmail] = useState<WriteResource<void, void>>({ data: void 0 });

  const navLinks =
    "resource" in user ? (
      <React.Fragment>
        <span sx={style.linkItem}>
          <NavLink to="/" onClick={() => setMobileMenuOpen(false)}>
            My maps
          </NavLink>
        </span>
        {user.resource.organizations.length > 0 && (
          <OrganizationDropdown organizations={user.resource.organizations} />
        )}
        <span sx={style.linkItem}>
          <NavLink to="/maps" onClick={() => setMobileMenuOpen(false)}>
            Community maps
          </NavLink>
        </span>
        <span
          sx={{
            svg: { display: "none" },
            span: {
              backgroundColor: "transparent !important"
            }
          }}
        >
          <SupportMenu />
        </span>
      </React.Fragment>
    ) : null;

  const userMenu =
    "resource" in user ? (
      <Wrapper onSelection={handleSelection(navigate)} sx={isMobile ? {} : { ml: 3 }}>
        <MenuButton sx={style.menuButton}>
          <Avatar
            name={user.resource.name}
            round={true}
            size={"2.5rem"}
            color={"#2c485e"}
            maxInitials={3}
            sx={style.avatar}
          />
          <Box sx={{ ml: 2, color: "heading" }}>
            <Icon name="angle-down" />
          </Box>
        </MenuButton>
        <Menu sx={style.menu}>
          <ul sx={style.menuList}>
            {isMobile && (
              <React.Fragment>
                <li key={UserMenuKeys.MyMaps}>
                  <MenuItem value={UserMenuKeys.MyMaps} sx={style.menuListItem}>
                    My maps
                  </MenuItem>
                </li>
                <li key={UserMenuKeys.CommunityMaps}>
                  <MenuItem value={UserMenuKeys.CommunityMaps} sx={style.menuListItem}>
                    Community maps
                  </MenuItem>
                </li>
                <li sx={{ borderBottom: "1px solid", borderColor: "gray.2", my: 1 }} />
              </React.Fragment>
            )}
            <li key={UserMenuKeys.Account}>
              <MenuItem value={UserMenuKeys.Account} sx={style.menuListItem}>
                Account
              </MenuItem>
            </li>
            <li key={UserMenuKeys.Logout}>
              <MenuItem value={UserMenuKeys.Logout} sx={style.menuListItem}>
                Logout
              </MenuItem>
            </li>
          </ul>
        </Menu>
      </Wrapper>
    ) : null;

  return (
    <Flex sx={{ flexDirection: "column" }}>
      {"resource" in user && !user.resource.isEmailVerified && (
        <Alert sx={{ borderRadius: "0" }}>
          <Box>
            Please confirm your email.{" "}
            <Box sx={{ display: "inline-block", p: 1 }}>
              {"resource" in resendEmail ? (
                <span sx={{ fontWeight: "body" }}>
                  Confirmation email sent to <b>{user.resource.email}</b>!
                </span>
              ) : (
                <React.Fragment>
                  <Button
                    sx={{
                      height: "auto",
                      cursor: "pointer",
                      textDecoration: "underline",
                      p: 0
                    }}
                    disabled={"isPending" in resendEmail && resendEmail.isPending}
                    onClick={() => {
                      setResendEmail({ ...resendEmail, isPending: true });
                      resendConfirmationEmail(user.resource.email)
                        .then(resource => setResendEmail({ data: resendEmail.data, resource }))
                        .catch(errors => setResendEmail({ data: resendEmail.data, errors }));
                    }}
                  >
                    Resend Email
                  </Button>
                </React.Fragment>
              )}
            </Box>
            {"errors" in resendEmail && (
              <Box sx={{ fontWeight: "body" }}>
                Error resending email. If this error persists, please contact us at{" "}
                <a sx={{ color: "muted" }} href="mailto:michael@maurizi.org">
                  michael@maurizi.org
                </a>
                .
              </Box>
            )}
          </Box>
        </Alert>
      )}
      <Flex as="header" sx={style.header}>
        <Heading as="h1" sx={{ mb: "0px", mr: "auto", pt: 2 }}>
          <Link to="/" sx={style.logoLink}>
            <Logo sx={{ width: isMobile ? "12rem" : "18rem" }} />
          </Link>
        </Heading>
        {isMobile && isLoggedIn ? (
          userMenu
        ) : isMobile ? (
          <Button
            sx={{
              bg: "transparent",
              color: "gray.8",
              p: 2,
              ml: 2,
              cursor: "pointer",
              "&:focus": { outline: "none", boxShadow: "focus" }
            }}
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle navigation menu"
          >
            <Icon name={mobileMenuOpen ? "times" : "bars"} />
          </Button>
        ) : !isLoggedIn && (!("isPending" in user) || !user.isPending) ? (
          <React.Fragment>
            <Link to="/login" sx={{ p: 2 }}>
              Login
            </Link>{" "}
            <Link to="/register" sx={{ p: 2 }}>
              Register
            </Link>
          </React.Fragment>
        ) : (
          <React.Fragment>
            {navLinks}
            {userMenu}
          </React.Fragment>
        )}
      </Flex>
      {isMobile && !isLoggedIn && mobileMenuOpen && (
        <Flex
          sx={{
            flexDirection: "column",
            bg: "gray.0",
            borderBottom: "1px solid",
            borderColor: "gray.1",
            boxShadow: "small",
            py: 2,
            px: 3
          }}
        >
          <Link
            to="/login"
            sx={{ py: 2, display: "block" }}
            onClick={() => setMobileMenuOpen(false)}
          >
            Login
          </Link>
          <Link
            to="/register"
            sx={{ py: 2, display: "block" }}
            onClick={() => setMobileMenuOpen(false)}
          >
            Register
          </Link>
        </Flex>
      )}
    </Flex>
  );
};

const handleSelection = (navigate: NavigateFunction) => (key: string | number) => {
  if (key === UserMenuKeys.Logout) {
    logout();
    navigate("/login");
  }

  if (key === UserMenuKeys.Account) {
    navigate("/user-account");
  }

  if (key === UserMenuKeys.MyMaps) {
    navigate("/");
  }

  if (key === UserMenuKeys.CommunityMaps) {
    navigate("/maps");
  }
};

export default SiteHeader;
