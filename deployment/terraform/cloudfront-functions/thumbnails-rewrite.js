// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

// CloudFront Function (viewer-request) for the `/thumbnails/*` behavior.
// The thumbnails bucket stores objects at the bare key `<id>.png`, but the
// user-facing URL namespaces them under `/thumbnails/` so the OG crawlers
// and home-page mini-map see a clean path on our domain. Strip the prefix
// before CloudFront forwards to the S3 origin.
function handler(event) {
  var request = event.request;
  if (request.uri.indexOf("/thumbnails/") === 0) {
    request.uri = request.uri.slice("/thumbnails".length);
  }
  return request;
}
