# Plan-only mocked-provider checks: no AWS calls or real resource mutations.
mock_provider "aws" {}

variables {
  budget_email = "operator@example.invalid"
}

run "seed_security_boundaries" {
  command = plan
  variables { create_dns_zone = false }

  assert {
    condition     = length(aws_route53_zone.flow) == 0
    error_message = "Seed must not create DNS before state migration."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_acls && aws_s3_bucket_public_access_block.state.block_public_policy && aws_s3_bucket_public_access_block.state.ignore_public_acls && aws_s3_bucket_public_access_block.state.restrict_public_buckets
    error_message = "State must never be publicly accessible."
  }
  assert {
    condition     = one(aws_s3_bucket_versioning.state.versioning_configuration).status == "Enabled" && one(one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "State must be encrypted and versioned."
  }
  assert {
    condition     = alltrue([for repository in aws_ecr_repository.image : repository.image_tag_mutability == "IMMUTABLE" && !repository.force_delete])
    error_message = "Deployment images must retain immutable identities."
  }
  assert {
    condition     = aws_budgets_budget.demo.limit_amount == "10" && aws_budgets_budget.demo.limit_unit == "USD" && aws_budgets_budget.demo.time_unit == "MONTHLY" && length(aws_budgets_budget.demo.notification) == 4
    error_message = "The approved monthly budget must have actual and forecast notifications."
  }
}

run "child_zone_only" {
  command = plan
  variables { create_dns_zone = true }
  assert {
    condition     = length(aws_route53_zone.flow) == 1 && aws_route53_zone.flow[0].name == "flow.edtosoy.com" && !aws_route53_zone.flow[0].force_destroy
    error_message = "DNS bootstrap must own only the persistent child zone."
  }
}

run "missing_notification_destination" {
  command = plan
  variables { budget_email = "" }
  expect_failures = [var.budget_email]
}
