# SES domain identity for transactional mail.
#
# Verifies the apex domain so the app can send FROM any address
# `@${var.domain_name}` (default: `noreply@`). DKIM keys are auto-generated
# by SES (Easy DKIM) and published as three CNAME records in the Route53
# zone. DMARC is set to monitor-only (`p=none`) with aggregate reports
# routed to var.alarm_email; tighten later once you've confirmed the volume
# and pipeline are clean.
#
# Gated on var.route53_zone_name because all the DNS plumbing only works
# when we own the zone in this account.

resource "aws_sesv2_email_identity" "domain" {
  count          = var.route53_zone_name == "" ? 0 : 1
  email_identity = var.domain_name
}

resource "aws_route53_record" "ses_dkim" {
  count   = var.route53_zone_name == "" ? 0 : 3
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = [
    "${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"
  ]
}

# Aggregate-report-only DMARC. Users of the domain see "monitor" semantics:
# nothing is rejected, but reports flow to the address below. Once the
# pipeline is stable, raise to `p=quarantine` then `p=reject`.
resource "aws_route53_record" "dmarc" {
  count   = var.route53_zone_name == "" ? 0 : 1
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [
    "v=DMARC1; p=none; rua=mailto:${var.alarm_email}"
  ]
}
