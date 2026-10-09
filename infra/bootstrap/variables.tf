variable "budget_email" {
  description = "User-approved notification address. Supply through ignored local configuration."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "An explicit budget notification email is required."
  }
}

variable "create_dns_zone" {
  description = "Enable only after the seed state has migrated to S3. Creation triggers the manual DNS STOP checkpoint."
  type        = bool
  default     = false
}
