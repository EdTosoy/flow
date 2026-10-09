data "aws_route53_zone" "flow" {
  name         = "flow.edtosoy.com."
  private_zone = false
}
resource "aws_acm_certificate" "demo" {
  domain_name       = "flow.edtosoy.com"
  validation_method = "DNS"
}
resource "aws_route53_record" "validation" {
  zone_id = data.aws_route53_zone.flow.zone_id
  name    = one(aws_acm_certificate.demo.domain_validation_options).resource_record_name
  type    = one(aws_acm_certificate.demo.domain_validation_options).resource_record_type
  ttl     = 60
  records = [one(aws_acm_certificate.demo.domain_validation_options).resource_record_value]
}
resource "aws_acm_certificate_validation" "demo" {
  certificate_arn         = aws_acm_certificate.demo.arn
  validation_record_fqdns = [aws_route53_record.validation.fqdn]
}
resource "aws_lb" "demo" {
  name                       = "flow-demo"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  idle_timeout               = 60
  enable_deletion_protection = false
}
resource "aws_lb_target_group" "app" {
  for_each = {
    ops = 3000, ingress = 4242
  }
  name                 = "flow-demo-${each.key}"
  port                 = each.value
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.demo.id
  deregistration_delay = 30
  health_check {
    path                = "/health/ready"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.demo.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }

  }

}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.demo.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.demo.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["ops"].arn
  }

}
resource "aws_lb_listener_rule" "stripe" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["ingress"].arn
  }
  condition {
    path_pattern {
      values = ["/webhooks/stripe"]
    }
  }

}
resource "aws_route53_record" "alb" {
  zone_id = data.aws_route53_zone.flow.zone_id
  name    = "flow.edtosoy.com"
  type    = "A"
  alias {
    name                   = aws_lb.demo.dns_name
    zone_id                = aws_lb.demo.zone_id
    evaluate_target_health = true
  }

}
