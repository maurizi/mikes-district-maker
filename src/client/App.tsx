import React from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Provider, RollbarContext } from "@rollbar/react";
import Rollbar from "rollbar";
import { ThemeUIProvider } from "theme-ui";
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

import "./App.css";
import StartProjectScreen from "./screens/StartProjectScreen";
import PublishedMapsListScreen from "./screens/PublishedMapsListScreen";
import { DEBUG } from "../shared/constants";

const PrivateRoute = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  const savedJWT = getJWT();
  const notLoggedIn = !savedJWT || jwtIsExpired(savedJWT);

  if (notLoggedIn) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

const environment = window.location.href.includes("staging") ? "staging" : "production";

const rollbarConfig: Rollbar.Configuration = {
  accessToken: import.meta.env.VITE_ROLLBAR_CLIENT_ACCESS_TOKEN || "",
  captureUncaught: true,
  captureUnhandledRejections: true,
  enabled: !DEBUG,
  nodeSourceMaps: true,
  payload: {
    environment,
    client: {
      javascript: {
        code_version: "1.18.2",
        source_map_enabled: true
      }
    }
  }
};

const AppRoutes = () => (
  <BrowserRouter>
    <QueryParamProvider adapter={ReactRouter6Adapter}>
      <Routes>
        <Route path="/" element={<PrivateRoute><RollbarContext context="home"><HomeScreen /></RollbarContext></PrivateRoute>} />
        <Route path="/o/:organizationSlug" element={<RollbarContext context="organization"><OrganizationScreen /></RollbarContext>} />
        <Route path="/o/:organizationSlug/admin" element={<PrivateRoute><RollbarContext context="organization-admin"><OrganizationAdminScreen /></RollbarContext></PrivateRoute>} />
        <Route path="/projects/:projectId" element={<RollbarContext context="project"><ProjectScreen /></RollbarContext>} />
        <Route path="/login" element={<RollbarContext context="login"><LoginScreen /></RollbarContext>} />
        <Route path="/maps" element={<RollbarContext context="published-map-list"><PublishedMapsListScreen /></RollbarContext>} />
        <Route path="/register" element={<RollbarContext context="register"><RegistrationScreen /></RollbarContext>} />
        <Route path="/forgot-password" element={<RollbarContext context="forgot-password"><ForgotPasswordScreen /></RollbarContext>} />
        <Route path="/activate/:token" element={<RollbarContext context="activate-account"><ActivateAccountScreen /></RollbarContext>} />
        <Route path="/activate/:token/:organizationSlug" element={<RollbarContext context="activate-account-organization"><ActivateAccountScreen /></RollbarContext>} />
        <Route path="/password-reset/:token" element={<RollbarContext context="reset-password"><ResetPasswordScreen /></RollbarContext>} />
        <Route path="/create-project" element={<PrivateRoute><RollbarContext context="create-project"><CreateProjectScreen /></RollbarContext></PrivateRoute>} />
        <Route path="/start-project" element={<PrivateRoute><RollbarContext context="start-project"><StartProjectScreen /></RollbarContext></PrivateRoute>} />
        <Route path="/import-project" element={<PrivateRoute><RollbarContext context="import-project"><ImportProjectScreen /></RollbarContext></PrivateRoute>} />
        <Route path="/user-account" element={<PrivateRoute><RollbarContext context="user-account"><UserAccountScreen /></RollbarContext></PrivateRoute>} />
      </Routes>
    </QueryParamProvider>
  </BrowserRouter>
);

const App = () => (
  <Provider config={rollbarConfig}>
    <ThemeUIProvider theme={theme}>
      <Toast />
      <AppRoutes />
    </ThemeUIProvider>
  </Provider>
);

export default App;
