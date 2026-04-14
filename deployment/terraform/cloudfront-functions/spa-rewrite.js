// CloudFront Function (viewer-request) that rewrites client-routed SPA paths
// to /index.html so React Router can take over on a page refresh.
//
// Skip conditions:
//  - Paths under /api/ or /healthcheck: these hit the Lambda origin and must
//    receive the real request URI, not a rewritten one.
//  - Paths with a file extension in the last segment (contain a `.`):
//    actual assets like /assets/index-abc.js or /favicon.ico must be served
//    directly from S3.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.indexOf("/api/") === 0 || uri === "/healthcheck") {
    return request;
  }

  var lastSlash = uri.lastIndexOf("/");
  var lastSegment = uri.slice(lastSlash + 1);
  if (lastSegment.indexOf(".") !== -1) {
    return request;
  }

  request.uri = "/index.html";
  return request;
}
