provider "aws" {
  region = var.aws_region

  # With deployment enabled, reject credentials for any account except the
  # explicitly confirmed account before resources are changed.
  allowed_account_ids = var.deployment_enabled ? [var.aws_account_id] : null

  default_tags {
    tags = local.common_tags
  }
}
