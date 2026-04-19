// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import jwtDecode from "jwt-decode";

import { type JWT } from "../shared/entities";

const JWT_ITEM_KEY = "jwt";

export const getJWT = () => localStorage.getItem(JWT_ITEM_KEY);
export const setJWT = (jwt: JWT) => localStorage.setItem(JWT_ITEM_KEY, jwt);
export const clearJWT = () => localStorage.removeItem(JWT_ITEM_KEY);
export const jwtIsExpired = (jwt: JWT) => {
  const payload = jwtDecode(jwt);
  return payload.exp < Math.round(new Date().getTime() / 1000);
};
export const isUserLoggedIn = (): boolean => {
  const token = getJWT();
  return token !== null && !jwtIsExpired(token);
};
