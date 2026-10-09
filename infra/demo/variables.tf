variable "images" {
  type        = map(string)
  description = "Reviewed immutable ECR image digests for ops, stripe and admin."
  validation {
    condition     = length(var.images) == 3 && alltrue([for name in ["ops", "stripe", "admin"] : can(regex("^163596511125\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/flow-demo/[^@]+@sha256:[0-9a-f]{64}$", var.images[name]))])
    error_message = "Use three approved-account immutable image digests."
  }

}
variable "secrets" {
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  description = "In-memory/write-only values. Never persisted in a Terraform plan or state."
}
variable "secrets_version" {
  type    = number
  default = 1
}
variable "stripe_account_id" {
  type = string
  validation {
    condition     = can(regex("^acct_[A-Za-z0-9]+$", var.stripe_account_id))
    error_message = "An explicit sandbox account is required."
  }

}
variable "stripe_source_id" {
  type    = string
  default = ""
}
variable "ops_book_id" {
  type    = string
  default = ""
}
variable "start_services" {
  type    = bool
  default = false
}
