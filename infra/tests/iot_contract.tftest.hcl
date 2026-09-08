mock_provider "aws" {}
mock_provider "archive" {}

run "isolated_fleet_contract" {
  command = plan

  variables {
    project_token            = "onboarding-juwon-test-m4d2"
    environment              = "dev"
    aws_account_id           = "123456789012"
    owner_tag                = "juwon"
    deployment_enabled       = true
    company_values_confirmed = true
    api_slice_enabled               = false
    enable_iot_fleet                = true
    enable_iot_rules                = false
    enable_backend_integrations     = false
    enable_fleet_registration_guard = false
    enable_device_decommission      = false
  }

  assert {
    condition     = length(aws_iot_policy.claim) == 1 && length(aws_iot_policy.bootstrap) == 1 && length(aws_iot_policy.runtime) == 1
    error_message = "Claim, bootstrap, and runtime must remain three separate policies."
  }

  assert {
    condition     = length(aws_iot_topic_rule.uplink) == 0
    error_message = "Topic Rules must stay off until a deployed Ingest Lambda ARN is confirmed."
  }

  assert {
    condition = (
      length(aws_dynamodb_table.device_registry) == 0 &&
      length(aws_lambda_function.fleet_registration_hook) == 0 &&
      length(aws_iot_policy_attachment.fleet_claim_certificate) == 0
    )
    error_message = "The manufacturing registry, Fleet hook, and claim attachment must remain absent without their explicit opt-in."
  }

  assert {
    condition     = local.iot_topic_root == "onboarding-juwon-test-m4d2/dev/tenants" && local.iot_topic_root_depth == 3
    error_message = "The unique project/environment namespace or topic() indexes drifted."
  }

  assert {
    condition = (
      length(local.runtime_policy) <= 2048 &&
      strcontains(local.runtime_policy, ":topic/onboarding-juwon-test-m4d2/dev/tenants/") &&
      !strcontains(local.runtime_policy, "\"Action\":[\"iot:*\"]")
    )
    error_message = "Runtime policy must fit the IoT limit and remain inside the isolated topic tree without iot:* actions."
  }

  assert {
    condition     = local.iot_provisioning_exact_star_actions == ["iot:RegisterThing"]
    error_message = "Resource=* must not grant anything except iot:RegisterThing."
  }
}

run "fleet_registration_guard_contract" {
  command = plan

  variables {
    project_token                   = "onboarding-juwon-test-m4d2"
    environment                     = "dev"
    aws_account_id                  = "123456789012"
    owner_tag                       = "juwon"
    deployment_enabled              = true
    company_values_confirmed        = true
    api_slice_enabled               = true
    cognito_callback_urls           = ["moodlight://auth/callback"]
    cognito_logout_urls             = ["moodlight://auth/logout"]
    cors_allow_origins              = ["http://localhost:3000"]
    enable_iot_fleet                = true
    enable_fleet_registration_guard = true
    fleet_claim_certificate_id      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition = (
      length(aws_dynamodb_table.device_registry) == 1 &&
      length(aws_lambda_function.fleet_registration_hook) == 1 &&
      aws_dynamodb_table.device_registry[0].deletion_protection_enabled &&
      aws_lambda_function.fleet_registration_hook[0].timeout == 4 &&
      contains(local.api_dynamodb_actions.device_registry, "dynamodb:GetItem") &&
      contains(local.api_dynamodb_actions.device_registry, "dynamodb:UpdateItem")
    )
    error_message = "The opt-in must create one protected registry and one hook that stays inside the Fleet five-second limit."
  }

  assert {
    condition = (
      aws_lambda_permission.fleet_registration_hook[0].source_account == "123456789012" &&
      aws_lambda_permission.fleet_registration_hook[0].source_arn == "arn:aws:iot:ap-northeast-2:123456789012:provisioningtemplate/onb-juwon-test-m4d2-dev-fleet" &&
      aws_lambda_function.fleet_registration_hook[0].environment[0].variables.FLEET_CLAIM_CLIENT_ID_PREFIX == "openiot-onboarding-juwon-test-m4d2-dev-claim-"
    )
    error_message = "Fleet may invoke the hook only from this exact account, template, and project client-id prefix."
  }

  assert {
    condition = (
      length(aws_iot_policy_attachment.fleet_claim_certificate) == 1 &&
      aws_iot_policy_attachment.fleet_claim_certificate[0].policy == aws_iot_policy.claim[0].name &&
      aws_iot_policy_attachment.fleet_claim_certificate[0].target == "arn:aws:iot:ap-northeast-2:123456789012:cert/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    )
    error_message = "The claim policy must attach to exactly the configured moodlight-only certificate ARN."
  }

  assert {
    condition = (
      strcontains(aws_iot_provisioning_template.moodlamp[0].template_body, "RegistrationNonceHash") &&
      strcontains(aws_iot_provisioning_template.moodlamp[0].template_body, "ClaimId") &&
      strcontains(aws_iot_provisioning_template.moodlamp[0].template_body, "TenantId") &&
      strcontains(aws_iot_provisioning_template.moodlamp[0].template_body, "PoolId") &&
      strcontains(aws_iot_provisioning_template.moodlamp[0].template_body, "tenant_id") &&
      strcontains(aws_iot_provisioning_template.moodlamp[0].template_body, "pool_id") &&
      strcontains(aws_iot_provisioning_template.moodlamp[0].template_body, "topicBase")
    )
    error_message = "The hook-owned Tenant and Pool must become Thing attributes and the returned full topicBase."
  }
}
