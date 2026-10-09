output "state_bucket" {
  description = "Encrypted/versioned state bucket; use separate bootstrap and demo keys."
  value       = aws_s3_bucket.state.id
}

output "image_repositories" {
  value = { for name, repository in aws_ecr_repository.image : name => repository.repository_url }
}

output "hosted_zone_id" {
  value = try(aws_route53_zone.flow[0].zone_id, null)
}

output "name_servers" {
  description = "MANDATORY STOP: ask the user to delegate flow with these four actual NS values."
  value       = try(aws_route53_zone.flow[0].name_servers, [])
}

output "budget_name" {
  value = aws_budgets_budget.demo.name
}
