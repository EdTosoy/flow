output "url" {
  value = "https://flow.edtosoy.com"
}
output "database_address" {
  value = aws_db_instance.demo.address
}
output "cluster" {
  value = aws_ecs_cluster.demo.name
}
output "task_definitions" {
  value = {
    for k, v in aws_ecs_task_definition.app : k => v.arn
  }
}
output "task_security_groups" {
  value = {
    for k, v in aws_security_group.task : k => v.id
  }
}
output "public_subnets" {
  value = aws_subnet.public[*].id
}
output "services" {
  value = {
    for k, v in aws_ecs_service.app : k => v.name
  }
}
output "log_groups" {
  value = {
    for k, v in aws_cloudwatch_log_group.app : k => v.name
  }
}
output "target_groups" {
  value = {
    for k, v in aws_lb_target_group.app : k => v.arn
  }
}
output "alb_arn" {
  value = aws_lb.demo.arn
}
output "certificate_arn" {
  value = aws_acm_certificate.demo.arn
}
