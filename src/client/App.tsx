// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import React, { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ThemeUIProvider, useColorMode } from "theme-ui";
import { QueryParamProvider } from "use-query-params";
import { ReactRouter6Adapter } from "use-query-params/adapters/react-router-6";

import { getJWT, jwtIsExpired } from "./jwt";
import Toast from "./components/Toast";
import ActivateAccountScreen from "./screens/ActivateAccountScreen";
import CreateProjectScreen from "./screens/CreateProjectScreen";
import ForgotPasswordScreen from "./screens/ForgotPasswordScreen";
import HomeScreen from "./screens/HomeScreen";
import ImportProjectScreen from "./screens/ImportProjectScreen";
import LoginScreen from "./screens/LoginScreen";
import OrganizationScreen from "./screens/OrganizationScreen";
import OrganizationAdminScreen from "./screens/OrganizationAdminScreen";
import ProjectScreen from "./screens/ProjectScreen";
import RegistrationScreen from "./screens/RegistrationScreen";
import ResetPasswordScreen from "./screens/ResetPasswordScreen";
import UserAccountScreen from "./screens/UserAccountScreen";
import theme from "./theme";
import { useColorModePreference } from "./hooks/useColorModePreference";
import { awsRum } from "./rum";

import "./App.css";
import StartProjectScreen from "./screens/StartProjectScreen";
import PublishedMapsListScreen from "./screens/PublishedMapsListScreen";
import LandingScreen from "./screens/LandingScreen";
import TermsScreen from "./screens/TermsScreen";
import PrivacyScreen from "./screens/PrivacyScreen";

const PrivateRoute = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  const savedJWT = getJWT();
  const notLoggedIn = !savedJWT || jwtIsExpired(savedJWT);

  if (notLoggedIn) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

const RootRoute = () => {
  const savedJWT = getJWT();
  const loggedIn = savedJWT && !jwtIsExpired(savedJWT);
  return loggedIn ? <HomeScreen /> : <LandingScreen />;
};

const RumPageTracker = () => {
  const location = useLocation();
  useEffect(() => {
    awsRum?.recordPageView(location.pathname);
  }, [location.pathname]);
  return null;
};

const AppRoutes = () => (
  <BrowserRouter>
    <QueryParamProvider adapter={ReactRouter6Adapter}>
      <RumPageTracker />
      <Routes>
        <Route path="/" element={<RootRoute />} />
        <Route path="/terms" element={<TermsScreen />} />
        <Route path="/privacy" element={<PrivacyScreen />} />
        <Route path="/o/:organizationSlug" element={<OrganizationScreen />} />
        <Route
          path="/o/:organizationSlug/admin"
          element={
            <PrivateRoute>
              <OrganizationAdminScreen />
            </PrivateRoute>
          }
        />
        <Route path="/projects/:projectId" element={<ProjectScreen />} />
        <Route path="/login" element={<LoginScreen />} />
        <Route path="/maps" element={<PublishedMapsListScreen />} />
        <Route path="/register" element={<RegistrationScreen />} />
        <Route path="/forgot-password" element={<ForgotPasswordScreen />} />
        <Route path="/activate/:token" element={<ActivateAccountScreen />} />
        <Route path="/activate/:token/:organizationSlug" element={<ActivateAccountScreen />} />
        <Route path="/password-reset/:token" element={<ResetPasswordScreen />} />
        <Route
          path="/create-project"
          element={
            <PrivateRoute>
              <CreateProjectScreen />
            </PrivateRoute>
          }
        />
        <Route
          path="/start-project"
          element={
            <PrivateRoute>
              <StartProjectScreen />
            </PrivateRoute>
          }
        />
        <Route
          path="/import-project"
          element={
            <PrivateRoute>
              <ImportProjectScreen />
            </PrivateRoute>
          }
        />
        <Route
          path="/user-account"
          element={
            <PrivateRoute>
              <UserAccountScreen />
            </PrivateRoute>
          }
        />
      </Routes>
    </QueryParamProvider>
  </BrowserRouter>
);

// Applies the user's color-mode preference. When "system", follows the OS
// prefers-color-scheme (including runtime changes). When "light"/"dark", pins
// the mode and ignores the OS.
const ColorModeController = () => {
  const [, setColorMode] = useColorMode();
  const preference = useColorModePreference();
  useEffect(() => {
    if (preference === "light") {
      setColorMode("default");
      return;
    }
    if (preference === "dark") {
      setColorMode("dark");
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (matches: boolean) => setColorMode(matches ? "dark" : "default");
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    apply(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [preference, setColorMode]);
  return null;
};

const App = () => (
  <ThemeUIProvider theme={theme}>
    <ColorModeController />
    <Toast />
    <AppRoutes />
  </ThemeUIProvider>
);

export default App;
