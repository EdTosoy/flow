terraform {
  backend "s3" {
    bucket              = "flow-demo-tfstate-163596511125-us-east-1"
    key                 = "demo/terraform.tfstate"
    region              = "us-east-1"
    profile             = "iamadmin-general"
    allowed_account_ids = ["163596511125"]
    encrypt             = true
    use_lockfile        = true
  }
}
