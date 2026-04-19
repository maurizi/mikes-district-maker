// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

// Placeholder Lambda handler. Terraform packages this as the initial
// deployment so the Lambda resource can be created before any real server
// code is built. CI replaces it with the NestJS + LWA bundle on first
// deploy (aws lambda update-function-code).
exports.handler = async () => ({
  statusCode: 503,
  headers: { "content-type": "text/plain" },
  body: "Lambda placeholder — CI has not yet deployed the real application."
});
