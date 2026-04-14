import React, { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
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
import { awsRum } from "./rum";

import "./App.css";
import StartProjectScreen from "./screens/StartProjectScreen";
import PublishedMapsListScreen from "./screens/PublishedMapsListScreen";

const PrivateRoute = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  const savedJWT = getJWT();
  const notLoggedIn = !savedJWT || jwtIsExpired(savedJWT);

  if (notLoggedIn) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
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
        <Route
          path="/"
          element={
            <PrivateRoute>
              <HomeScreen />
            </PrivateRoute>
          }
        />
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
        <Route
          path="/activate/:token/:organizationSlug"
          element={<ActivateAccountScreen />}
        />
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

const App = () => (
  <ThemeUIProvider theme={theme}>
    <Toast />
    <AppRoutes />
  </ThemeUIProvider>
);

export default App;
