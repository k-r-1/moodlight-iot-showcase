data "archive_file" "api" {
  count = local.api_slice_enabled ? 1 : 0

  type        = "zip"
  source_file = "${path.module}/../backend/dist/index.mjs"
  output_path = "${path.module}/moodlight-api.zip"
}

resource "aws_cloudwatch_log_group" "api" {
  count = local.api_slice_enabled ? 1 : 0

  name              = "/aws/lambda/${local.prefix}-api"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_lambda_function" "api" {
  count = local.api_slice_enabled ? 1 : 0

  function_name = "${local.prefix}-api"
  role          = aws_iam_role.api[0].arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  timeout       = 29
  memory_size   = 256

  filename         = data.archive_file.api[0].output_path
  source_code_hash = data.archive_file.api[0].output_base64sha256

  environment {
    variables = merge({
      TABLE_TENANT       = aws_dynamodb_table.domain["tenant"].name
      TABLE_MEMBERSHIP   = aws_dynamodb_table.domain["membership"].name
      TABLE_POOL         = aws_dynamodb_table.domain["pool"].name
      TABLE_SCHEDULE     = aws_dynamodb_table.domain["schedule"].name
      TABLE_DEVICE       = aws_dynamodb_table.domain["device"].name
      TABLE_DEVICE_CLAIM = aws_dynamodb_table.domain["device_claim"].name
      }, local.fleet_registration_guard_enabled ? {
      TABLE_DEVICE_REGISTRY = aws_dynamodb_table.device_registry[0].name
      } : {}, local.backend_integrations_enabled ? {
      IOT_DATA_ENDPOINT           = data.aws_iot_endpoint.data[0].endpoint_address
      IOT_TOPIC_ROOT              = local.iot_topic_root
      SCHEDULER_GROUP_NAME        = aws_scheduler_schedule_group.moodlight[0].name
      SCHEDULE_NAME_PREFIX        = local.scheduler_name_prefix
      SCHEDULE_TARGET_ARN         = local.schedule_lambda_arn
      SCHEDULE_EXECUTION_ROLE_ARN = local.scheduler_execution_role_arn
      } : {}, local.backend_integrations_enabled && local.fleet_registration_guard_enabled ? {
      IOT_PROVISIONING_THING_NAME_PREFIX      = local.iot_thing_prefix
      IOT_PROVISIONING_THING_TYPE_NAME        = aws_iot_thing_type.moodlamp[0].name
      IOT_PROVISIONING_CERTIFICATE_ARN_PREFIX = "${local.iot_arn_prefix}:cert/"
      IOT_PROVISIONING_BOOTSTRAP_POLICY_NAME  = aws_iot_policy.bootstrap[0].name
      IOT_PROVISIONING_RUNTIME_POLICY_NAME    = aws_iot_policy.runtime[0].name
      } : {}, local.backend_integrations_enabled && var.enable_device_decommission ? {
      IOT_CERTIFICATE_ARN_PREFIX = "${local.iot_arn_prefix}:cert/"
      IOT_POLICY_NAME_PREFIX     = "${local.prefix}-"
      IOT_THING_NAME_PREFIX      = local.iot_thing_prefix
    } : {})
  }

  depends_on = [aws_cloudwatch_log_group.api]
}
