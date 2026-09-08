locals {
  fleet_registration_guard_enabled = local.iot_enabled && var.enable_fleet_registration_guard
  fleet_template_arn               = "${local.iot_arn_prefix}:provisioningtemplate/${local.fleet_name}"
  fleet_claim_client_id_prefix     = "${local.prefix}-claim-"
  fleet_claim_certificate_arn      = "${local.iot_arn_prefix}:cert/${lower(var.fleet_claim_certificate_id)}"
}

resource "aws_iot_policy_attachment" "fleet_claim_certificate" {
  count = local.fleet_registration_guard_enabled ? 1 : 0

  policy = aws_iot_policy.claim[0].name
  target = local.fleet_claim_certificate_arn
}

resource "aws_dynamodb_table" "device_registry" {
  count = local.fleet_registration_guard_enabled ? 1 : 0

  name         = "${local.prefix}-device-registry"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "serialHash"

  deletion_protection_enabled = true

  attribute {
    name = "serialHash"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [terraform_data.deployment_guard]
}

data "archive_file" "fleet_registration_hook" {
  count = local.fleet_registration_guard_enabled ? 1 : 0

  type        = "zip"
  source_file = "${path.module}/../backend/dist/fleet-registration-hook.mjs"
  output_path = "${path.module}/moodlight-fleet-registration-hook.zip"
}

resource "aws_cloudwatch_log_group" "fleet_registration_hook" {
  count = local.fleet_registration_guard_enabled ? 1 : 0

  name              = "/aws/lambda/${local.prefix}-fleet-guard"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_iam_role" "fleet_registration_hook" {
  count = local.fleet_registration_guard_enabled ? 1 : 0

  name = "${local.prefix}-fleet-guard-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "fleet_registration_hook" {
  count = local.fleet_registration_guard_enabled ? 1 : 0

  name = "${local.prefix}-fleet-guard-policy"
  role = aws_iam_role.fleet_registration_hook[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.fleet_registration_hook[0].arn}:*"
      },
      {
        Sid      = "ReserveRegisteredDevice"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.device_registry[0].arn
      }
    ]
  })
}

resource "aws_lambda_function" "fleet_registration_hook" {
  count = local.fleet_registration_guard_enabled ? 1 : 0

  function_name = "${local.prefix}-fleet-guard"
  role          = aws_iam_role.fleet_registration_hook[0].arn
  runtime       = "nodejs22.x"
  handler       = "fleet-registration-hook.handler"
  architectures = ["arm64"]
  timeout       = 4
  memory_size   = 128

  filename         = data.archive_file.fleet_registration_hook[0].output_path
  source_code_hash = data.archive_file.fleet_registration_hook[0].output_base64sha256

  environment {
    variables = {
      TABLE_DEVICE_REGISTRY        = aws_dynamodb_table.device_registry[0].name
      FLEET_TEMPLATE_ARN           = local.fleet_template_arn
      FLEET_CLAIM_CERTIFICATE_ID   = lower(var.fleet_claim_certificate_id)
      FLEET_CLAIM_CLIENT_ID_PREFIX = local.fleet_claim_client_id_prefix
    }
  }

  depends_on = [aws_cloudwatch_log_group.fleet_registration_hook]
}

resource "aws_lambda_permission" "fleet_registration_hook" {
  count = local.fleet_registration_guard_enabled ? 1 : 0

  statement_id   = "AllowExactMoodlightFleetTemplate"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.fleet_registration_hook[0].function_name
  principal      = "iot.amazonaws.com"
  source_account = var.aws_account_id
  source_arn     = local.fleet_template_arn
}
