mock_provider "aws" {}
variables {
  images = {
    ops    = "163596511125.dkr.ecr.us-east-1.amazonaws.com/flow-demo/ops@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    stripe = "163596511125.dkr.ecr.us-east-1.amazonaws.com/flow-demo/stripe@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    admin  = "163596511125.dkr.ecr.us-east-1.amazonaws.com/flow-demo/admin@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  stripe_account_id = "acct_test"
  secrets = {
    admin_password      = "test-not-a-real-password", provisioning = "{}", stripe_key = "test-not-a-real-key"
    webhook_secrets     = "pending", demo_username = "demo", demo_password = "test-not-a-real-password"
    operations_password = "test-not-a-real-password", ingress_password = "test-not-a-real-password", stripeworker_password = "test-not-a-real-password"
  }
}
run "private_disposable_database_and_disabled_services" {
  command = plan
  assert {
    condition     = !aws_db_instance.demo.publicly_accessible && !aws_db_instance.demo.multi_az && aws_db_instance.demo.storage_encrypted && aws_db_instance.demo.skip_final_snapshot && !aws_db_instance.demo.deletion_protection && aws_db_instance.demo.backup_retention_period == 0
    error_message = "Database must be private, encrypted, Single-AZ and disposable."
  }
  assert {
    condition     = alltrue([for service in aws_ecs_service.app : service.desired_count == 0]) && alltrue([for p in aws_ssm_parameter.runtime : p.type == "SecureString"])
    error_message = "Provision secrets and capabilities before enabling services."
  }
  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.database) == 2 && length(aws_vpc_security_group_ingress_rule.postgres) == 5 && length(aws_vpc_security_group_ingress_rule.app) == 2
    error_message = "Only approved task boundaries may reach the private database and ALB applications."
  }
}
run "fail_closed_before_scope_provisioning" {
  command = plan
  variables { start_services = true }
  expect_failures = [aws_ecs_task_definition.app]
}
