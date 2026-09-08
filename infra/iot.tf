locals {
  iot_enabled       = var.deployment_enabled && var.enable_iot_fleet
  iot_rules_enabled = local.iot_enabled && var.enable_iot_rules
  iot_arn_prefix    = "arn:aws:iot:${var.aws_region}:${var.aws_account_id}"
  # Provisioning template names are limited to 36 characters. Keep the full
  # unique onboarding token, shortening only the fixed "onboarding" word.
  fleet_name = "${replace(var.project_token, "onboarding-", "onb-")}-${var.environment}-fleet"

  runtime_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectAsOwnThing"
        Effect   = "Allow"
        Action   = ["iot:Connect"]
        Resource = ["${local.iot_arn_prefix}:client/${local.iot_thing_variable}"]
      },
      {
        Sid    = "PublishOwnUplink"
        Effect = "Allow"
        Action = ["iot:Publish"]
        Resource = [
          for kind in ["state", "tele", "evt"] :
          "${local.iot_arn_prefix}:topic/${local.iot_device_base}/${kind}"
        ]
      },
      {
        Sid      = "SubscribeOwnCommand"
        Effect   = "Allow"
        Action   = ["iot:Subscribe"]
        Resource = ["${local.iot_arn_prefix}:topicfilter/${local.iot_device_base}/cmd"]
      },
      {
        Sid      = "ReceiveOwnCommand"
        Effect   = "Allow"
        Action   = ["iot:Receive"]
        Resource = ["${local.iot_arn_prefix}:topic/${local.iot_device_base}/cmd"]
      }
    ]
  })

  bootstrap_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectAsAttachedThing"
        Effect   = "Allow"
        Action   = ["iot:Connect"]
        Resource = ["${local.iot_arn_prefix}:client/${local.iot_thing_variable}"]
        Condition = {
          Bool = { "iot:Connection.Thing.IsAttached" = ["true"] }
        }
      }
    ]
  })

  claim_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectForProvisioningOnly"
        Effect   = "Allow"
        Action   = ["iot:Connect"]
        Resource = ["${local.iot_arn_prefix}:client/${local.prefix}-claim-*"]
      },
      {
        Sid    = "ProvisioningPublishReceive"
        Effect = "Allow"
        Action = ["iot:Publish", "iot:Receive"]
        Resource = [
          "${local.iot_arn_prefix}:topic/$aws/certificates/create/*",
          "${local.iot_arn_prefix}:topic/$aws/provisioning-templates/${local.fleet_name}/provision/*"
        ]
      },
      {
        Sid    = "ProvisioningSubscribe"
        Effect = "Allow"
        Action = ["iot:Subscribe"]
        Resource = [
          "${local.iot_arn_prefix}:topicfilter/$aws/certificates/create/*",
          "${local.iot_arn_prefix}:topicfilter/$aws/provisioning-templates/${local.fleet_name}/provision/*"
        ]
      }
    ]
  })

  rule_fields = {
    state = "messageId, bootId, bootStartedAtMs, bootSequence, stateSequence, commandId, power, red, green, blue, brightness"
    tele  = "messageId, bootId, bootStartedAtMs, bootSequence, telemetrySequence, uptimeSeconds, rssi, firmwareVersion"
    evt   = "messageId, bootId, bootStartedAtMs, bootSequence, eventSequence, eventType, occurredAt"
  }

  # AWS defines no resource type for RegisterThing. Keep the unavoidable
  # exact-star exception named and testable instead of hiding it in JSON.
  iot_provisioning_exact_star_actions = ["iot:RegisterThing"]
}

resource "aws_iot_thing_type" "moodlamp" {
  count = local.iot_enabled ? 1 : 0
  name  = "${local.prefix}-moodlamp"

  properties {
    description           = "Isolated onboarding mood lamp"
    searchable_attributes = ["tenant_id", "pool_id", "serial"]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iot_thing_group" "fleet" {
  count = local.iot_enabled ? 1 : 0
  name  = "${local.prefix}-fleet-lamps"

  properties {
    description = "Claimed mood lamps eligible for later operations"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iot_policy" "claim" {
  count  = local.iot_enabled ? 1 : 0
  name   = "${local.prefix}-lamp-claim"
  policy = local.claim_policy

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iot_policy" "bootstrap" {
  count  = local.iot_enabled ? 1 : 0
  name   = "${local.prefix}-lamp-bootstrap"
  policy = local.bootstrap_policy

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = length(local.bootstrap_policy) <= 2048
      error_message = "Bootstrap IoT policy exceeds the 2,048-character limit."
    }
  }
}

resource "aws_iot_policy" "runtime" {
  count  = local.iot_enabled ? 1 : 0
  name   = "${local.prefix}-lamp-device"
  policy = local.runtime_policy

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = length(local.runtime_policy) <= 2048
      error_message = "Runtime IoT policy exceeds the 2,048-character limit."
    }
  }
}

resource "aws_iam_role" "iot_provisioning" {
  count = local.iot_enabled ? 1 : 0
  name  = "${local.prefix}-iot-provisioning-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "iot.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnEquals    = { "aws:SourceArn" = "${local.iot_arn_prefix}:provisioningtemplate/${local.fleet_name}" }
      }
    }]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role_policy" "iot_provisioning" {
  count = local.iot_enabled ? 1 : 0
  name  = "${local.prefix}-iot-provisioning-policy"
  role  = aws_iam_role.iot_provisioning[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ThingRegistration"
        Effect = "Allow"
        Action = ["iot:CreateThing", "iot:DescribeThing", "iot:UpdateThing", "iot:ListThingGroupsForThing", "iot:ListThingPrincipals", "iot:DetachThingPrincipal", "iot:AttachThingPrincipal"]
        Resource = [
          "${local.iot_arn_prefix}:thing/${local.iot_thing_prefix}*",
          "${local.iot_arn_prefix}:cert/*"
        ]
      },
      {
        Sid      = "ThingTypeRead"
        Effect   = "Allow"
        Action   = ["iot:DescribeThingType"]
        Resource = [aws_iot_thing_type.moodlamp[0].arn]
      },
      {
        Sid      = "CertificateWorkflow"
        Effect   = "Allow"
        Action   = ["iot:UpdateCertificate", "iot:DescribeCertificate", "iot:RegisterCertificate", "iot:ListAttachedPolicies", "iot:ListPrincipalPolicies", "iot:AttachPolicy", "iot:AttachPrincipalPolicy"]
        Resource = ["${local.iot_arn_prefix}:cert/*"]
      },
      {
        Sid      = "BootstrapPolicyRead"
        Effect   = "Allow"
        Action   = ["iot:GetPolicy", "iot:ListTargetsForPolicy", "iot:ListPolicyPrincipals"]
        Resource = [aws_iot_policy.bootstrap[0].arn]
      },
      {
        Sid      = "RegisterThingHasNoResourceType"
        Effect   = "Allow"
        Action   = local.iot_provisioning_exact_star_actions
        Resource = ["*"]
      }
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iot_provisioning_template" "moodlamp" {
  count                 = local.iot_enabled ? 1 : 0
  name                  = local.fleet_name
  description           = "Isolated claim-based mood lamp provisioning"
  enabled               = true
  provisioning_role_arn = aws_iam_role.iot_provisioning[0].arn

  template_body = jsonencode({
    Parameters = merge({
      SerialNumber                = { Type = "String" }
      "AWS::IoT::Certificate::Id" = { Type = "String" }
      }, local.fleet_registration_guard_enabled ? {
      ClaimId               = { Type = "String" }
      RegistrationNonceHash = { Type = "String" }
      TenantId              = { Type = "String" }
      PoolId                = { Type = "String" }
    } : {})
    DeviceConfiguration = jsondecode(local.fleet_registration_guard_enabled ? jsonencode({
      topicBase = {
        "Fn::Join" = ["/", [
          local.iot_topic_root,
          { Ref = "TenantId" },
          "pools",
          { Ref = "PoolId" },
          { "Fn::Join" = ["", [local.iot_thing_prefix, { Ref = "SerialNumber" }]] },
        ]]
      }
    }) : jsonencode({ topicRoot = local.iot_topic_root }))
    Resources = {
      certificate = {
        Type = "AWS::IoT::Certificate"
        Properties = {
          CertificateId = { Ref = "AWS::IoT::Certificate::Id" }
          Status        = "ACTIVE"
        }
      }
      policy = {
        Type       = "AWS::IoT::Policy"
        Properties = { PolicyName = aws_iot_policy.bootstrap[0].name }
      }
      thing = {
        Type = "AWS::IoT::Thing"
        Properties = {
          ThingName     = { "Fn::Join" = ["", [local.iot_thing_prefix, { Ref = "SerialNumber" }]] }
          ThingTypeName = aws_iot_thing_type.moodlamp[0].name
          AttributePayload = merge(
            { serial = { Ref = "SerialNumber" } },
            local.fleet_registration_guard_enabled ? {
              tenant_id = { Ref = "TenantId" }
              pool_id   = { Ref = "PoolId" }
            } : {},
          )
        }
        OverrideSettings = {
          ThingTypeName    = "REPLACE"
          AttributePayload = "MERGE"
        }
      }
    }
  })

  dynamic "pre_provisioning_hook" {
    for_each = local.fleet_registration_guard_enabled ? [1] : []
    content {
      payload_version = "2020-04-01"
      target_arn      = aws_lambda_function.fleet_registration_hook[0].arn
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [aws_lambda_permission.fleet_registration_hook]
}

resource "aws_iot_topic_rule" "uplink" {
  for_each = local.iot_rules_enabled ? local.rule_fields : {}

  name        = replace("${local.prefix}_${each.key}", "-", "_")
  description = "Route isolated ${each.key} messages to the confirmed Ingest Lambda"
  enabled     = true
  sql         = "SELECT ${each.value}, '${each.key}' AS kind, topic(4) AS tenantId, topic(6) AS poolId, topic(7) AS thingName FROM '${local.iot_topic_root}/+/pools/+/+/${each.key}' WHERE startswith(topic(7), '${local.iot_thing_prefix}')"
  sql_version = "2016-03-23"

  lambda {
    function_arn = local.ingest_lambda_arn
  }
}

resource "aws_lambda_permission" "iot_uplink" {
  for_each = local.iot_rules_enabled ? local.rule_fields : {}

  statement_id   = "AllowIoT${title(each.key)}"
  action         = "lambda:InvokeFunction"
  function_name  = local.ingest_lambda_arn
  principal      = "iot.amazonaws.com"
  source_arn     = aws_iot_topic_rule.uplink[each.key].arn
  source_account = var.aws_account_id
}
