// CloudFront Function (viewer-request) that rewrites client-routed SPA paths
// to /index.html so React Router can take over on a page refresh.
//
// Two exceptions, in order:
//  - Crawlers hitting /projects/:id get rewritten to /og/projects/:id so the
//    backend can serve a tiny HTML document with OpenGraph meta tags (and the
//    og:image URL). Humans on the same path continue to the SPA.
//  - Paths under /api/, /og/, or /healthcheck hit the Lambda origin and must
//    receive the real request URI, not a rewritten one.
//  - Paths with a file extension in the last segment (contain a `.`):
//    actual assets like /assets/index-abc.js or /favicon.ico must be served
//    directly from S3.
var BOT_UA = /(Twitterbot|facebookexternalhit|LinkedInBot|Slackbot|Discordbot|Bluesky|WhatsApp|Telegram|Pinterest|bingbot|Googlebot|Applebot|Mastodon|Yandex|DuckDuckBot)/i;
var PROJECT_PATH = /^\/projects\/([^/]+)\/?$/;

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (
    uri.indexOf("/api/") === 0 ||
    uri.indexOf("/og/") === 0 ||
    uri.indexOf("/thumbnails/") === 0 ||
    uri === "/healthcheck"
  ) {
    return request;
  }

  var projectMatch = PROJECT_PATH.exec(uri);
  if (projectMatch) {
    var uaHeader = request.headers["user-agent"];
    var ua = uaHeader ? uaHeader.value : "";
    if (BOT_UA.test(ua)) {
      request.uri = "/og/projects/" + projectMatch[1];
      return request;
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
