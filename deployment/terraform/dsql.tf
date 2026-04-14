resource "aws_dsql_cluster" "main" {
  deletion_protection_enabled = var.enable_production_safeguards

  tags = {
    Name = "${var.project}-${var.environment}"
  }
}

locals {
  dsql_endpoint = "${aws_dsql_cluster.main.identifier}.dsql.${var.aws_region}.on.aws"
}
