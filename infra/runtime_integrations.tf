variable "enable_backend_integrations" {
  description = "Opt in to the local Ingest/Scheduler Lambdas and AWS IoT runtime adapters after deployment values are confirmed."
  type        = bool
  default     = false
}

locals {
  backend_integrations_enabled     = local.api_slice_enabled && local.iot_enabled && var.enable_backend_integrations
  ingest_lambda_arn                = local.backend_integrations_enabled ? aws_lambda_function.ingest[0].arn : var.ingest_lambda_arn
  schedule_lambda_arn              = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.prefix}-scheduled-execution"
  scheduler_execution_role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${local.prefix}-scheduler-execution"
  scheduler_group_arn              = "arn:aws:scheduler:${var.aws_region}:${var.aws_account_id}:schedule-group/${local.prefix}"
  scheduler_name_prefix            = "ml-${substr(sha256("${var.project_token}/${var.environment}"), 0, 16)}"
  scheduler_schedule_arn           = "arn:aws:scheduler:${var.aws_region}:${var.aws_account_id}:schedule/${local.prefix}/${local.scheduler_name_prefix}-*"
  command_topic_arn                = "${local.iot_arn_prefix}:topic/${local.iot_topic_root}/*/pools/*/${local.iot_thing_prefix}*/cmd"
  fleet_finalize_condition_actions = ["dynamodb:ConditionCheckItem"]
}

data "aws_iot_endpoint" "data" {
  count         = local.backend_integrations_enabled ? 1 : 0
  endpoint_type = "iot:Data-ATS"
}

data "archive_file" "ingest" {
  count       = local.backend_integrations_enabled ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/../backend/dist/ingest.mjs"
  output_path = "${path.module}/moodlight-ingest.zip"
}

data "archive_file" "schedule" {
  count       = local.backend_integrations_enabled ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/../backend/dist/schedule.mjs"
  output_path = "${path.module}/moodlight-schedule.zip"
}

resource "aws_cloudwatch_log_group" "ingest" {
  count             = local.backend_integrations_enabled ? 1 : 0
  name              = "/aws/lambda/${local.prefix}-ingest"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_cloudwatch_log_group" "schedule" {
  count             = local.backend_integrations_enabled ? 1 : 0
  name              = "/aws/lambda/${local.prefix}-scheduled-execution"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_iam_role" "ingest" {
  count = local.backend_integrations_enabled ? 1 : 0
  name  = "${local.prefix}-ingest-role"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" }
  }] })
}

resource "aws_iam_role_policy" "ingest" {
  count = local.backend_integrations_enabled ? 1 : 0
  name  = "${local.prefix}-ingest-policy"
  role  = aws_iam_role.ingest[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.ingest[0].arn}:*" },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource = [aws_dynamodb_table.domain["device"].arn, aws_dynamodb_table.domain["device_claim"].arn] }
  ] })
}

resource "aws_lambda_function" "ingest" {
  count            = local.backend_integrations_enabled ? 1 : 0
  function_name    = "${local.prefix}-ingest"
  role             = aws_iam_role.ingest[0].arn
  runtime          = "nodejs22.x"
  handler          = "ingest.handler"
  architectures    = ["arm64"]
  timeout          = 15
  memory_size      = 256
  filename         = data.archive_file.ingest[0].output_path
  source_code_hash = data.archive_file.ingest[0].output_base64sha256
  environment { variables = {
    TABLE_TENANT       = aws_dynamodb_table.domain["tenant"].name, TABLE_MEMBERSHIP = aws_dynamodb_table.domain["membership"].name,
    TABLE_POOL         = aws_dynamodb_table.domain["pool"].name, TABLE_DEVICE = aws_dynamodb_table.domain["device"].name,
    TABLE_DEVICE_CLAIM = aws_dynamodb_table.domain["device_claim"].name
  } }
  depends_on = [aws_cloudwatch_log_group.ingest]
}

resource "aws_iam_role" "schedule_lambda" {
  count = local.backend_integrations_enabled ? 1 : 0
  name  = "${local.prefix}-schedule-lambda-role"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" }
  }] })
}

resource "aws_iam_role_policy" "schedule_lambda" {
  count = local.backend_integrations_enabled ? 1 : 0
  name  = "${local.prefix}-schedule-lambda-policy"
  role  = aws_iam_role.schedule_lambda[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.schedule[0].arn}:*" },
    { Effect = "Allow", Action = ["dynamodb:GetItem"], Resource = aws_dynamodb_table.domain["membership"].arn },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], Resource = aws_dynamodb_table.domain["device"].arn },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource = aws_dynamodb_table.domain["schedule"].arn },
    { Effect = "Allow", Action = ["dynamodb:Query"], Resource = "${aws_dynamodb_table.domain["schedule"].arn}/index/sync-status-updated-index" },
    { Effect = "Allow", Action = ["iot:Publish"], Resource = local.command_topic_arn },
    { Effect = "Allow", Action = ["scheduler:GetSchedule", "scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule"], Resource = local.scheduler_schedule_arn },
    { Effect = "Allow", Action = ["iam:PassRole"], Resource = local.scheduler_execution_role_arn, Condition = { StringEquals = { "iam:PassedToService" = "scheduler.amazonaws.com" } } }
  ] })
}

resource "aws_lambda_function" "schedule" {
  count            = local.backend_integrations_enabled ? 1 : 0
  function_name    = "${local.prefix}-scheduled-execution"
  role             = aws_iam_role.schedule_lambda[0].arn
  runtime          = "nodejs22.x"
  handler          = "schedule.handler"
  architectures    = ["arm64"]
  timeout          = 29
  memory_size      = 256
  filename         = data.archive_file.schedule[0].output_path
  source_code_hash = data.archive_file.schedule[0].output_base64sha256
  environment { variables = {
    TABLE_TENANT         = aws_dynamodb_table.domain["tenant"].name, TABLE_MEMBERSHIP = aws_dynamodb_table.domain["membership"].name,
    TABLE_POOL           = aws_dynamodb_table.domain["pool"].name, TABLE_SCHEDULE = aws_dynamodb_table.domain["schedule"].name,
    TABLE_DEVICE         = aws_dynamodb_table.domain["device"].name, TABLE_DEVICE_CLAIM = aws_dynamodb_table.domain["device_claim"].name,
    IOT_DATA_ENDPOINT    = data.aws_iot_endpoint.data[0].endpoint_address,
    IOT_TOPIC_ROOT       = local.iot_topic_root,
    SCHEDULER_GROUP_NAME = aws_scheduler_schedule_group.moodlight[0].name, SCHEDULE_NAME_PREFIX = local.scheduler_name_prefix,
    SCHEDULE_TARGET_ARN  = local.schedule_lambda_arn, SCHEDULE_EXECUTION_ROLE_ARN = local.scheduler_execution_role_arn
  } }
  depends_on = [aws_cloudwatch_log_group.schedule]
}

resource "aws_scheduler_schedule_group" "moodlight" {
  count = local.backend_integrations_enabled ? 1 : 0
  name  = local.prefix
}

resource "aws_iam_role" "scheduler_execution" {
  count = local.backend_integrations_enabled ? 1 : 0
  name  = "${local.prefix}-scheduler-execution"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Action = "sts:AssumeRole", Principal = { Service = "scheduler.amazonaws.com" },
    Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id }, ArnEquals = { "aws:SourceArn" = local.scheduler_group_arn } }
  }] })
}

resource "aws_iam_role_policy" "scheduler_execution" {
  count  = local.backend_integrations_enabled ? 1 : 0
  name   = "${local.prefix}-invoke-scheduled-execution"
  role   = aws_iam_role.scheduler_execution[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = local.schedule_lambda_arn }] })
}

resource "aws_iam_role_policy" "api_integrations" {
  count = local.backend_integrations_enabled && local.api_slice_enabled ? 1 : 0
  name  = "${local.prefix}-api-integrations"
  role  = aws_iam_role.api[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["iot:Publish"], Resource = local.command_topic_arn },
    { Effect = "Allow", Action = ["scheduler:GetSchedule", "scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule"], Resource = local.scheduler_schedule_arn },
    { Effect = "Allow", Action = ["iam:PassRole"], Resource = local.scheduler_execution_role_arn, Condition = { StringEquals = { "iam:PassedToService" = "scheduler.amazonaws.com" } } }
  ] })
}

resource "aws_iam_role_policy" "api_fleet_finalize" {
  count = local.backend_integrations_enabled && local.fleet_registration_guard_enabled ? 1 : 0
  name  = "${local.prefix}-api-fleet-finalize"
  role  = aws_iam_role.api[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    {
      Sid      = "VerifyProvisionedThing"
      Effect   = "Allow"
      Action   = ["iot:DescribeThing", "iot:ListThingPrincipals"]
      Resource = "${local.iot_arn_prefix}:thing/${local.iot_thing_prefix}*"
    },
    {
      Sid      = "VerifyProvisionedCertificate"
      Effect   = "Allow"
      Action   = ["iot:DescribeCertificate", "iot:ListAttachedPolicies"]
      Resource = "${local.iot_arn_prefix}:cert/*"
    },
    {
      Sid    = "TransitionProvisionedCertificatePolicy"
      Effect = "Allow"
      Action = ["iot:AttachPolicy", "iot:DetachPolicy"]
      Resource = [
        "${local.iot_arn_prefix}:cert/*",
        aws_iot_policy.bootstrap[0].arn,
        aws_iot_policy.runtime[0].arn,
      ]
    },
    {
      Sid    = "CheckDurableFleetBinding"
      Effect = "Allow"
      Action = local.fleet_finalize_condition_actions
      Resource = [
        aws_dynamodb_table.domain["device"].arn,
        aws_dynamodb_table.domain["device_claim"].arn,
        aws_dynamodb_table.device_registry[0].arn,
      ]
    },
  ] })
}

resource "aws_iam_role_policy" "api_decommission" {
  count = local.backend_integrations_enabled && var.enable_device_decommission ? 1 : 0
  name  = "${local.prefix}-api-device-decommission"
  role  = aws_iam_role.api[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["iot:UpdateCertificate", "iot:ListAttachedPolicies"], Resource = "${local.iot_arn_prefix}:cert/*" },
    { Effect = "Allow", Action = ["iot:DetachPolicy"], Resource = ["${local.iot_arn_prefix}:cert/*", aws_iot_policy.runtime[0].arn, aws_iot_policy.bootstrap[0].arn] },
    { Effect = "Allow", Action = ["iot:ListThingPrincipals", "iot:DeleteThing"], Resource = "${local.iot_arn_prefix}:thing/${local.iot_thing_prefix}*" },
    { Effect = "Allow", Action = ["iot:DetachThingPrincipal"], Resource = "${local.iot_arn_prefix}:cert/*", Condition = { ArnLike = { "iot:thingArn" = "${local.iot_arn_prefix}:thing/${local.iot_thing_prefix}*" } } },
  ] })
}


resource "aws_cloudwatch_event_rule" "schedule_reconcile" {
  count               = local.backend_integrations_enabled ? 1 : 0
  name                = "${local.prefix}-schedule-reconcile"
  description         = "Retry due Schedule sync records through the trusted worker"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "schedule_reconcile" {
  count     = local.backend_integrations_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.schedule_reconcile[0].name
  target_id = "schedule-reconcile"
  arn       = aws_lambda_function.schedule[0].arn
  input     = jsonencode({ action = "RECONCILE_DUE", limit = 100 })
}

resource "aws_lambda_permission" "schedule_reconcile" {
  count          = local.backend_integrations_enabled ? 1 : 0
  statement_id   = "AllowEventBridgeScheduleReconcile"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.schedule[0].function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.schedule_reconcile[0].arn
  source_account = var.aws_account_id
}
