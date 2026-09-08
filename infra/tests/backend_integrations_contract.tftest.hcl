mock_provider "aws" {
  override_during = plan
}
mock_provider "archive" {}

run "backend_integrations_default_off" {
  command = plan

  # Keep this contract independent from a developer's ignored terraform.tfvars.
  variables {
    deployment_enabled              = false
    company_values_confirmed        = false
    api_slice_enabled               = false
    enable_iot_fleet                = false
    enable_iot_rules                = false
    enable_backend_integrations     = false
    enable_fleet_registration_guard = false
    enable_device_decommission      = false
  }

  assert {
    condition = (
      length(aws_lambda_function.ingest) == 0 &&
      length(aws_lambda_function.schedule) == 0 &&
      length(aws_scheduler_schedule_group.moodlight) == 0
    )
    error_message = "AWS runtime integrations must create no resources by default."
  }
}

run "backend_integrations_are_scoped" {
  command = plan

  variables {
    project_token               = "onboarding-juwon-test-m4d2"
    environment                 = "dev"
    aws_account_id              = "123456789012"
    aws_region                  = "ap-northeast-2"
    owner_tag                   = "juwon"
    deployment_enabled          = true
    company_values_confirmed    = true
    api_slice_enabled           = true
    enable_iot_fleet            = true
    enable_iot_rules            = true
    enable_backend_integrations     = true
    enable_fleet_registration_guard = false
    enable_device_decommission      = false
    cognito_callback_urls       = ["openiot-moodlight://auth/callback"]
    cognito_logout_urls         = ["openiot-moodlight://auth/logout"]
    cors_allow_origins          = ["http://localhost:3210"]
  }

  assert {
    condition = (
      length(aws_lambda_function.ingest) == 1 &&
      length(aws_lambda_function.schedule) == 1 &&
      length(aws_scheduler_schedule_group.moodlight) == 1 &&
      length(aws_cloudwatch_event_rule.schedule_reconcile) == 1 &&
      length(aws_iot_topic_rule.uplink) == 3 &&
      length(aws_iam_role_policy.api_fleet_finalize) == 0 &&
      length(aws_iam_role_policy.api_decommission) == 0
    )
    error_message = "The integration opt-in must create workers and rules without enabling account-scoped certificate cleanup."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.scheduler_execution[0].assume_role_policy).Statement[0].Condition.ArnEquals["aws:SourceArn"] ==
      "arn:aws:scheduler:ap-northeast-2:123456789012:schedule-group/openiot-onboarding-juwon-test-m4d2-dev"
    )
    error_message = "Scheduler trust must be limited to the one project schedule group."
  }

  assert {
    condition     = length(local.scheduler_name_prefix) <= 31 && startswith(local.scheduler_schedule_arn, "arn:aws:scheduler:")
    error_message = "The deterministic Scheduler name prefix must leave room for the 32-character schedule hash."
  }

  assert {
    condition = strcontains(
      local.command_topic_arn,
      ":topic/onboarding-juwon-test-m4d2/dev/tenants/*/pools/*/openiot-onboarding-juwon-test-m4d2-dev-lamp-*/cmd",
    )
    error_message = "Scheduled command publish must stay inside the project cmd topic tree."
  }
}

run "fleet_finalize_is_guarded_and_scoped" {
  command = plan

  override_resource {
    target = aws_dynamodb_table.domain["device"]
    values = { arn = "arn:aws:dynamodb:ap-northeast-2:123456789012:table/openiot-onboarding-juwon-test-m4d2-dev-device" }
  }
  override_resource {
    target = aws_dynamodb_table.domain["device_claim"]
    values = { arn = "arn:aws:dynamodb:ap-northeast-2:123456789012:table/openiot-onboarding-juwon-test-m4d2-dev-device-claim" }
  }
  override_resource {
    target = aws_dynamodb_table.device_registry[0]
    values = { arn = "arn:aws:dynamodb:ap-northeast-2:123456789012:table/openiot-onboarding-juwon-test-m4d2-dev-device-registry" }
  }
  override_resource {
    target = aws_iot_policy.bootstrap[0]
    values = { arn = "arn:aws:iot:ap-northeast-2:123456789012:policy/openiot-onboarding-juwon-test-m4d2-dev-bootstrap" }
  }
  override_resource {
    target = aws_iot_policy.runtime[0]
    values = { arn = "arn:aws:iot:ap-northeast-2:123456789012:policy/openiot-onboarding-juwon-test-m4d2-dev-runtime" }
  }

  variables {
    project_token                   = "onboarding-juwon-test-m4d2"
    environment                     = "dev"
    aws_account_id                  = "123456789012"
    aws_region                      = "ap-northeast-2"
    owner_tag                       = "juwon"
    deployment_enabled              = true
    company_values_confirmed        = true
    api_slice_enabled               = true
    enable_iot_fleet                = true
    enable_backend_integrations     = true
    enable_fleet_registration_guard = true
    fleet_claim_certificate_id      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    cognito_callback_urls           = ["openiot-moodlight://auth/callback"]
    cognito_logout_urls             = ["openiot-moodlight://auth/logout"]
    cors_allow_origins              = ["http://localhost:3210"]
  }

  assert {
    condition = (
      length(aws_iam_role_policy.api_fleet_finalize) == 1 &&
      aws_lambda_function.api[0].environment[0].variables.IOT_PROVISIONING_THING_NAME_PREFIX == "openiot-onboarding-juwon-test-m4d2-dev-lamp-" &&
      aws_lambda_function.api[0].environment[0].variables.IOT_PROVISIONING_THING_TYPE_NAME == aws_iot_thing_type.moodlamp[0].name &&
      aws_lambda_function.api[0].environment[0].variables.IOT_PROVISIONING_BOOTSTRAP_POLICY_NAME == aws_iot_policy.bootstrap[0].name &&
      aws_lambda_function.api[0].environment[0].variables.IOT_PROVISIONING_RUNTIME_POLICY_NAME == aws_iot_policy.runtime[0].name
    )
    error_message = "Fleet finalization must be wired only when both backend integrations and the registration guard are enabled."
  }

  assert {
    condition = (
      local.fleet_finalize_condition_actions == ["dynamodb:ConditionCheckItem"] &&
      length(aws_iam_role_policy.api_fleet_finalize) == 1
    )
    error_message = "Fleet finalization must grant DynamoDB ConditionCheckItem only inside its guarded policy."
  }
}

run "device_decommission_requires_a_second_opt_in" {
  command = plan

  variables {
    project_token               = "onboarding-juwon-test-m4d2"
    environment                 = "dev"
    aws_account_id              = "123456789012"
    aws_region                  = "ap-northeast-2"
    owner_tag                   = "juwon"
    deployment_enabled          = true
    company_values_confirmed    = true
    api_slice_enabled           = true
    enable_iot_fleet            = true
    enable_backend_integrations = true
    enable_device_decommission  = true
    cognito_callback_urls       = ["openiot-moodlight://auth/callback"]
    cognito_logout_urls         = ["openiot-moodlight://auth/logout"]
    cors_allow_origins          = ["http://localhost:3210"]
  }

  assert {
    condition     = length(aws_iam_role_policy.api_decommission) == 1
    error_message = "Certificate and Thing cleanup permissions must exist only after the second explicit opt-in."
  }
}
