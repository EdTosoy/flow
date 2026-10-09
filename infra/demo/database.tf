resource "aws_db_subnet_group" "demo" {
  name       = "flow-demo"
  subnet_ids = aws_subnet.database[*].id
}
resource "aws_db_parameter_group" "demo" {
  name   = "flow-demo-pg18"
  family = "postgres18"
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

}
resource "aws_db_instance" "demo" {
  identifier                   = "flow-demo"
  engine                       = "postgres"
  engine_version               = "18.6"
  instance_class               = "db.t4g.micro"
  allocated_storage            = 20
  max_allocated_storage        = 0
  storage_type                 = "gp3"
  storage_encrypted            = true
  db_name                      = "flow"
  username                     = "flow_admin"
  password_wo                  = var.secrets["admin_password"]
  password_wo_version          = 1
  db_subnet_group_name         = aws_db_subnet_group.demo.name
  parameter_group_name         = aws_db_parameter_group.demo.name
  vpc_security_group_ids       = [aws_security_group.database.id]
  publicly_accessible          = false
  multi_az                     = false
  backup_retention_period      = 0
  delete_automated_backups     = true
  deletion_protection          = false
  skip_final_snapshot          = true
  auto_minor_version_upgrade   = false
  apply_immediately            = true
  monitoring_interval          = 0
  performance_insights_enabled = false
  ca_cert_identifier           = "rds-ca-rsa2048-g1"
}
locals {
  runtime_values = merge({
    admin_url       = "postgresql://flow_admin:${var.secrets["admin_password"]}@${aws_db_instance.demo.address}:5432/flow?sslmode=verify-full"
    provisioning    = var.secrets["provisioning"]
    stripe_key      = var.secrets["stripe_key"]
    webhook_secrets = var.secrets["webhook_secrets"]
    demo_username   = var.secrets["demo_username"]
    demo_password   = var.secrets["demo_password"]
    }, {
    for kind in ["operations", "ingress", "stripeworker"] : "${kind}_url" => "postgresql://flow_demo_${kind}:${var.secrets["${kind}_password"]}@${aws_db_instance.demo.address}:5432/flow?sslmode=verify-full"
  })
}
resource "aws_ssm_parameter" "runtime" {
  for_each         = toset(["admin_url", "provisioning", "stripe_key", "webhook_secrets", "demo_username", "demo_password", "operations_url", "ingress_url", "stripeworker_url"])
  name             = "/flow/demo/${each.key}"
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = local.runtime_values[each.key]
  value_wo_version = var.secrets_version
}
