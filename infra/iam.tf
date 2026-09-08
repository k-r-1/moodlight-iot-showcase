locals {
  api_dynamodb_actions = {
    membership  = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"]
    tenant_pool = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"]
    schedule    = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    device      = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    device_gsi  = ["dynamodb:Query"]
    device_claim = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]
    device_registry = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
  }
}

resource "aws_iam_role" "api" {
  count = local.api_slice_enabled ? 1 : 0

  name = "${local.prefix}-api-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "api" {
  count = local.api_slice_enabled ? 1 : 0

  name = "${local.prefix}-api-policy"
  role = aws_iam_role.api[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "WriteFunctionLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.api[0].arn}:*"
      },
      {
        Sid      = "UseMembership"
        Effect   = "Allow"
        Action   = local.api_dynamodb_actions.membership
        Resource = aws_dynamodb_table.domain["membership"].arn
      },
      {
        Sid      = "BootstrapTenantAndPool"
        Effect   = "Allow"
        Action   = local.api_dynamodb_actions.tenant_pool
        Resource = [aws_dynamodb_table.domain["tenant"].arn, aws_dynamodb_table.domain["pool"].arn]
      },
      {
        Sid      = "UseSchedules"
        Effect   = "Allow"
        Action   = local.api_dynamodb_actions.schedule
        Resource = aws_dynamodb_table.domain["schedule"].arn
      },
      {
        Sid      = "ReadAndUpdateDevice"
        Effect   = "Allow"
        Action   = local.api_dynamodb_actions.device
        Resource = aws_dynamodb_table.domain["device"].arn
      },
      {
        Sid      = "QueryDeviceIndex"
        Effect   = "Allow"
        Action   = local.api_dynamodb_actions.device_gsi
        Resource = "${aws_dynamodb_table.domain["device"].arn}/index/tenant-pool-devices-index"
      },
      {
        Sid      = "UseDeviceClaims"
        Effect   = "Allow"
        Action   = local.api_dynamodb_actions.device_claim
        Resource = aws_dynamodb_table.domain["device_claim"].arn
      }
      ], local.fleet_registration_guard_enabled ? [{
        Sid      = "ReserveRegisteredDevice"
        Effect   = "Allow"
        Action   = local.api_dynamodb_actions.device_registry
        Resource = aws_dynamodb_table.device_registry[0].arn
    }] : [])
  })
}
