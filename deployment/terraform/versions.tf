terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.5"
    }
  }

  backend "s3" {
    bucket  = "districtbuilder-tf-state-238046523378"
    key     = "districtbuilder/production/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform-v2"
    }
  }
}

# CloudFront certificates must be provisioned in us-east-1 regardless of the
# stack's primary region, so we keep a second aliased provider for ACM.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform-v2"
    }
  }
}
