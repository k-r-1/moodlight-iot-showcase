resource "aws_cognito_user_pool" "main" {
  count = local.api_slice_enabled ? 1 : 0

  name                     = "${local.prefix}-user-pool"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = "ACTIVE"

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
    require_uppercase = false
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cognito_user_pool_client" "app" {
  count = local.api_slice_enabled ? 1 : 0

  name         = "${local.prefix}-app-client"
  user_pool_id = aws_cognito_user_pool.main[0].id

  generate_secret                      = false
  prevent_user_existence_errors        = "ENABLED"
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = var.cognito_callback_urls
  logout_urls                          = var.cognito_logout_urls
  supported_identity_providers         = ["COGNITO"]
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
}

resource "aws_cognito_user_pool_domain" "main" {
  count = local.api_slice_enabled ? 1 : 0

  domain       = local.prefix
  user_pool_id = aws_cognito_user_pool.main[0].id
}
