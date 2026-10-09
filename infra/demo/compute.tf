locals {
  workloads = {
    ops = {
      image = var.images["ops"], command = ["node", "apps/ops/server.js"], port = 3000, memory = 1024, parameters = {
        DATABASE_OPERATIONS_URL = "operations_url", FLOW_DEMO_USERNAME = "demo_username", FLOW_DEMO_PASSWORD = "demo_password"
      }
    }
    ingress = {
      image = var.images["stripe"], command = ["node", "tools/ingress.cjs"], port = 4242, memory = 512, parameters = {
        STRIPE_INGRESS_DATABASE_URL = "ingress_url", STRIPE_WEBHOOK_SECRETS = "webhook_secrets"
      }
    }
    worker = {
      image = var.images["stripe"], command = ["node", "tools/worker.cjs"], port = 0, memory = 512, parameters = {
        STRIPE_WORKER_DATABASE_URL = "stripeworker_url", STRIPE_SECRET_KEY = "stripe_key"
      }
    }
    admin = {
      image = var.images["admin"], command = ["node", "tools/provision.cjs"], port = 0, memory = 1024, parameters = {
        DATABASE_ADMIN_URL = "admin_url", FLOW_PROVISIONING_CONFIG = "provisioning"
      }
    }
    verify = {
      image = var.images["admin"], command = ["node", "tools/verify.cjs"], port = 0, memory = 512, parameters = {
        STRIPE_SECRET_KEY = "stripe_key", STRIPE_INGRESS_DATABASE_URL = "ingress_url", STRIPE_WORKER_DATABASE_URL = "stripeworker_url"
      }
    }

  }

}
resource "aws_ecs_cluster" "demo" {
  name = "flow-demo"
}
resource "aws_cloudwatch_log_group" "app" {
  for_each          = local.workloads
  name              = "/flow/demo/${each.key}"
  retention_in_days = 3
}
resource "aws_iam_role" "execution" {
  for_each = local.workloads
  name     = "flow-demo-${each.key}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = "163596511125" }, ArnLike = { "aws:SourceArn" = "arn:aws:ecs:us-east-1:163596511125:*" } }
    }]
  })
}
resource "aws_iam_role" "task" {
  for_each           = local.workloads
  name               = "flow-demo-${each.key}-task"
  assume_role_policy = aws_iam_role.execution[each.key].assume_role_policy
  # Runtime uses PostgreSQL and Stripe
  # No AWS API permissions are granted.
}
resource "aws_iam_role_policy" "execution" {
  for_each = local.workloads
  name     = "flow-demo-execution"
  role     = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = "arn:aws:ecr:us-east-1:163596511125:repository/flow-demo/${each.key == "ingress" || each.key == "worker" ? "stripe" : each.key == "verify" ? "admin" : each.key}"
      },
      {
        Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.app[each.key].arn}:*"
      },
      {
        Effect = "Allow", Action = ["ssm:GetParameters"], Resource = [for parameter in values(each.value.parameters) : aws_ssm_parameter.runtime[parameter].arn]
    }]
  })
}
resource "aws_ecs_task_definition" "app" {
  for_each                 = local.workloads
  family                   = "flow-demo-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name = each.key, image = each.value.image, command = each.value.command, essential = true,
    user = "1000:1000", readonlyRootFilesystem = each.key != "ops", stopTimeout = 60,
    portMappings = each.value.port == 0 ? [] : [{
      containerPort = each.value.port, protocol = "tcp"
    }],
    environment = [
      {
        name = "FLOW_DEPLOYMENT_MODE", value = "demo"
        }, {
        name = "STRIPE_MODE", value = "sandbox"
      },
      {
        name = "STRIPE_ACCOUNT_ID", value = var.stripe_account_id
        }, {
        name = "STRIPE_SOURCE_ACCOUNT_ID", value = var.stripe_source_id
      },
      {
        name = "OPS_BOOK_ID", value = var.ops_book_id
        }, {
        name = "STRIPE_INGRESS_HOST", value = "0.0.0.0"
    }],
    secrets = [for name, parameter in each.value.parameters : {
      name = name, valueFrom = aws_ssm_parameter.runtime[parameter].arn
    }],
    logConfiguration = {
      logDriver = "awslogs", options = {
        awslogs-group = aws_cloudwatch_log_group.app[each.key].name, awslogs-region = "us-east-1", awslogs-stream-prefix = "flow"
      }
    }

  }])
  depends_on = [aws_iam_role_policy.execution]
  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = !var.start_services || (can(regex("^[0-9a-f-]{36}$", var.stripe_source_id)) && can(regex("^[0-9a-f-]{36}$", var.ops_book_id)))
      error_message = "Provision and verify narrow source credentials before starting services."
    }

  }

}
resource "aws_ecs_service" "app" {
  for_each = {
    for name, value in local.workloads : name => value if contains(["ops", "ingress", "worker"], name)
  }
  name                               = "flow-demo-${each.key}"
  cluster                            = aws_ecs_cluster.demo.id
  task_definition                    = aws_ecs_task_definition.app[each.key].arn
  desired_count                      = var.start_services ? 1 : 0
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = each.value.port == 0 ? null : 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task[each.key].id]
    assign_public_ip = true
  }
  dynamic "load_balancer" {
    for_each = each.value.port == 0 ? [] : [each.key]
    content {
      target_group_arn = aws_lb_target_group.app[each.key].arn
      container_name   = each.key
      container_port   = each.value.port
    }

  }
  depends_on = [aws_lb_listener.https, aws_lb_listener_rule.stripe]
}
