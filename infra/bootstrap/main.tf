locals {
  bucket_name = "flow-demo-tfstate-163596511125-us-east-1"
  images      = toset(["ops", "stripe", "admin"])
}

resource "aws_s3_bucket" "state" {
  bucket        = local.bucket_name
  force_destroy = false
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# Stripe ingress and Stripe worker share a provider-adapter image with different
# commands. The admin image is for one-shot migrations/provisioning, never a service.
resource "aws_ecr_repository" "image" {
  for_each             = local.images
  name                 = "flow-demo/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  encryption_configuration { encryption_type = "AES256" }
  image_scanning_configuration { scan_on_push = true }
  lifecycle { prevent_destroy = true }
}

resource "aws_ecr_lifecycle_policy" "image" {
  for_each   = local.images
  repository = aws_ecr_repository.image[each.key].name
  # Keep tagged deployment images: deleting an image still referenced by a task
  # definition would prevent safe task replacement or reproducible re-apply.
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged build remnants after seven days"
      selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_budgets_budget" "demo" {
  name         = "flow-demo-account-monthly"
  budget_type  = "COST"
  limit_amount = "10"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  # Account-wide so untagged infrastructure and bootstrap costs are not omitted.
  # Existing non-Flow spend also contributes. Alerts are not a spending cap.
  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = "ACTUAL"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = [var.budget_email]
    }
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "FORECASTED"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.budget_email]
  }
  lifecycle { prevent_destroy = true }
}

resource "aws_route53_zone" "flow" {
  count         = var.create_dns_zone ? 1 : 0
  name          = "flow.edtosoy.com"
  comment       = "Persistent delegated Flow demo child zone; parent stays on Cloudflare"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
