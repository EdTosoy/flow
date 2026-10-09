locals {
  prefix = "flow-demo"
  zones  = ["us-east-1a", "us-east-1b"]
}
resource "aws_vpc" "demo" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = {
    Name = local.prefix
  }

}
resource "aws_internet_gateway" "demo" {
  vpc_id = aws_vpc.demo.id
}
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.demo.id
  availability_zone       = local.zones[count.index]
  cidr_block              = "10.42.${count.index}.0/24"
  map_public_ip_on_launch = false
  tags = {
    Name = "${local.prefix}-public-${count.index}"
  }

}
resource "aws_subnet" "database" {
  count                   = 2
  vpc_id                  = aws_vpc.demo.id
  availability_zone       = local.zones[count.index]
  cidr_block              = "10.42.${count.index + 10}.0/24"
  map_public_ip_on_launch = false
  tags = {
    Name = "${local.prefix}-database-${count.index}"
  }

}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.demo.id
}
resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.demo.id
}
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table" "database" {
  vpc_id = aws_vpc.demo.id
}
resource "aws_route_table_association" "database" {
  count          = 2
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database.id
}
resource "aws_security_group" "alb" {
  name        = "flow-demo-alb"
  vpc_id      = aws_vpc.demo.id
  description = "Public HTTPS boundary"
}
resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}
resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_security_group" "task" {
  for_each    = toset(["ops", "ingress", "worker", "admin", "verify"])
  name        = "flow-demo-${each.key}"
  vpc_id      = aws_vpc.demo.id
  description = "Isolated ${each.key} task boundary"
}
resource "aws_security_group" "database" {
  name        = "flow-demo-database"
  vpc_id      = aws_vpc.demo.id
  description = "Private RDS; authorized tasks only"
}
resource "aws_vpc_security_group_ingress_rule" "app" {
  for_each = {
    ops = 3000, ingress = 4242
  }
  security_group_id            = aws_security_group.task[each.key].id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}
resource "aws_vpc_security_group_egress_rule" "alb_app" {
  for_each = {
    ops = 3000, ingress = 4242
  }
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.task[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}
resource "aws_vpc_security_group_ingress_rule" "postgres" {
  for_each                     = aws_security_group.task
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = each.value.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_egress_rule" "task_database" {
  for_each                     = aws_security_group.task
  security_group_id            = each.value.id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_egress_rule" "task_https" {
  for_each          = aws_security_group.task
  security_group_id = each.value.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
