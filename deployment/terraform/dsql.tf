resource "aws_dsql_cluster" "main" {
  deletion_protection_enabled = var.environment == "production"

  tags = {
    Name = "${var.project}-${var.environment}"
  }
}

locals {
  dsql_endpoint = "${aws_dsql_cluster.main.identifier}.dsql.${var.aws_region}.on.aws"
}
