// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

// CloudFront Function (viewer-request) that intercepts CORS preflight
// OPTIONS requests and returns a 204 with the appropriate headers.
// Without this, OPTIONS reaches S3 (which has no CORS config) and
// returns a non-2xx status, causing the browser to block the request.
function handler(event) {
  var request = event.request;
  if (request.method === "OPTIONS") {
    return {
      statusCode: 204,
      statusDescription: "No Content",
      headers: {
        "access-control-allow-origin": { value: "*" },
        "access-control-allow-methods": { value: "GET, HEAD, OPTIONS" },
        "access-control-allow-headers": { value: "Range, If-None-Match, If-Modified-Since" },
        "access-control-max-age": { value: "86400" }
      }
    };
  }
  return request;
}
