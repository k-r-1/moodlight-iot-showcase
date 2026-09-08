resource "aws_apigatewayv2_api" "http" {
  count = local.api_slice_enabled ? 1 : 0

  name          = "${local.prefix}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.cors_allow_origins
    allow_methods = ["GET", "POST", "PATCH", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 3000
  }
}

resource "aws_apigatewayv2_integration" "api" {
  count = local.api_slice_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.http[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api[0].invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  count = local.api_slice_enabled ? 1 : 0

  api_id           = aws_apigatewayv2_api.http[0].id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.prefix}-cognito-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.app[0].id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.main[0].id}"
  }
}

resource "aws_apigatewayv2_route" "options" {
  count = local.api_slice_enabled ? 1 : 0

  api_id             = aws_apigatewayv2_api.http[0].id
  route_key          = "OPTIONS /{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api[0].id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "default" {
  count = local.api_slice_enabled ? 1 : 0

  api_id             = aws_apigatewayv2_api.http[0].id
  route_key          = "$default"
  target             = "integrations/${aws_apigatewayv2_integration.api[0].id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt[0].id
}

resource "aws_cloudwatch_log_group" "apigw" {
  count = local.api_slice_enabled ? 1 : 0

  name              = "/aws/apigw/${local.prefix}"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  count = local.api_slice_enabled ? 1 : 0

  api_id      = aws_apigatewayv2_api.http[0].id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw[0].arn
    format = jsonencode({
      requestId        = "$context.requestId"
      method           = "$context.httpMethod"
      path             = "$context.path"
      status           = "$context.status"
      latencyMs        = "$context.responseLatency"
      response         = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 100
  }
}

resource "aws_lambda_permission" "apigw_api" {
  count = local.api_slice_enabled ? 1 : 0

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http[0].execution_arn}/*/*"
}
