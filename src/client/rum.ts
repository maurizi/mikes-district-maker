// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { AwsRum, type AwsRumConfig } from "aws-rum-web";
import { DEBUG } from "../shared/constants";

const APPLICATION_ID = import.meta.env.VITE_RUM_APP_MONITOR_ID;
const GUEST_ROLE_ARN = import.meta.env.VITE_RUM_GUEST_ROLE_ARN;
const IDENTITY_POOL_ID = import.meta.env.VITE_RUM_IDENTITY_POOL_ID;
const REGION = import.meta.env.VITE_RUM_REGION;
const APPLICATION_VERSION = "1.18.2";

function createRum(): AwsRum | undefined {
  if (DEBUG || !APPLICATION_ID || !GUEST_ROLE_ARN || !IDENTITY_POOL_ID || !REGION) {
    return undefined;
  }
  const config: AwsRumConfig = {
    sessionSampleRate: 1,
    guestRoleArn: GUEST_ROLE_ARN,
    identityPoolId: IDENTITY_POOL_ID,
    endpoint: `https://dataplane.rum.${REGION}.amazonaws.com`,
    telemetries: ["performance", "errors", "http"],
    allowCookies: true,
    enableXRay: false
  };
  try {
    return new AwsRum(APPLICATION_ID, APPLICATION_VERSION, REGION, config);
  } catch {
    // Initialization failure should never break the app
    return undefined;
  }
}

export const awsRum = createRum();
