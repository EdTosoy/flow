terraform {
  required_version = ">= 1.15.0, < 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.68.0"
    }
  }
  # Initial seed uses local state. The workflow generates backend.generated.tf
  # and migrates that state only AFTER this configuration creates the bucket.
}

provider "aws" {
  profile             = "iamadmin-general"
  region              = "us-east-1"
  allowed_account_ids = ["163596511125"]
  default_tags {
    tags = {
      Project     = "flow"
      Environment = "demo"
      Lifecycle   = "persistent"
      ManagedBy   = "terraform"
    }
  }
}
