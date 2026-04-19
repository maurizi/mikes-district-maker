// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

// CloudFront Function (viewer-request) attached to the default cache
// behavior. Handles two jobs:
//
//  1. Social-media crawlers hitting /projects/:id get a 302 redirect to
//     /og/projects/:id, which is a separate cache behavior that routes to
//     the Lambda origin. A redirect is required — NOT a URI rewrite —
//     because CloudFront picks the cache behavior (and therefore the origin)
//     from the ORIGINAL request URI before this function runs. Rewriting to
//     /og/... would still send the request to the s3-static origin and
//     produce a 403. The redirect bounces the crawler back through
//     CloudFront at the new path where /og/* maps to Lambda correctly.
//
//  2. SPA route refreshes (anything without a file extension) rewrite to
//     /index.html so React Router can take over on reload / deep link.
//
// Paths under /api/, /og/, /thumbnails/, or /healthcheck never land here —
// they match earlier ordered cache behaviors with their own configs.
var BOT_UA = /(Twitterbot|facebookexternalhit|LinkedInBot|Slackbot|Discordbot|Bluesky|WhatsApp|Telegram|Pinterest|bingbot|Googlebot|Applebot|Mastodon|Yandex|DuckDuckBot)/i;
var PROJECT_PATH = /^\/projects\/([^/]+)\/?$/;

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  var projectMatch = PROJECT_PATH.exec(uri);
  if (projectMatch) {
    var uaHeader = request.headers["user-agent"];
    var ua = uaHeader ? uaHeader.value : "";
    if (BOT_UA.test(ua)) {
      return {
        statusCode: 302,
        statusDescription: "Found",
        headers: {
          location: { value: "/og/projects/" + projectMatch[1] },
          "cache-control": { value: "no-store" }
        }
      };
    }
  }

  var lastSlash = uri.lastIndexOf("/");
  var lastSegment = uri.slice(lastSlash + 1);
  if (lastSegment.indexOf(".") !== -1) {
    return request;
  }

  request.uri = "/index.html";
  return request;
}
