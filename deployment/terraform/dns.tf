# DNS is only wired up when route53_zone_name is supplied. If you manage DNS
# outside Route53 set the variable empty and point records at the CloudFront
# distribution + ALB manually.
data "aws_route53_zone" "main" {
  count        = var.route53_zone_name == "" ? 0 : 1
  name         = var.route53_zone_name
  private_zone = false
}

# Public domain → CloudFront
resource "aws_route53_record" "app" {
  count   = var.route53_zone_name == "" ? 0 : 1
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "app_aaaa" {
  count   = var.route53_zone_name == "" ? 0 : 1
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# ACM DNS validation record for the CloudFront cert.
resource "aws_route53_record" "cloudfront_cert_validation" {
  for_each = var.route53_zone_name == "" ? {} : {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main[0].zone_id
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider                = aws.us_east_1
  count                   = var.route53_zone_name == "" ? 0 : 1
  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for r in aws_route53_record.cloudfront_cert_validation : r.fqdn]
}
