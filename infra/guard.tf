resource "terraform_data" "deployment_guard" {
  input = {
    deployment_enabled       = var.deployment_enabled
    company_values_confirmed = var.company_values_confirmed
  }

  lifecycle {
    precondition {
      condition = !var.deployment_enabled || (
        var.company_values_confirmed &&
        var.project_token != "unconfirmed" &&
        var.owner_tag != "unconfirmed" &&
        var.aws_region == "ap-northeast-2" &&
        can(regex("^[0-9]{12}$", var.aws_account_id))
      )
      error_message = "Deployment requires confirmed company values, Seoul ap-northeast-2, a non-placeholder project/owner, and a 12-digit AWS account ID."
    }

    precondition {
      condition = !var.api_slice_enabled || (
        var.deployment_enabled &&
        length(var.cognito_callback_urls) > 0 &&
        length(var.cognito_logout_urls) > 0 &&
        length(var.cors_allow_origins) > 0
      )
      error_message = "The API slice requires deployment enabled plus confirmed callback, logout, and CORS origins."
    }


    precondition {
      condition = !var.enable_iot_fleet || (
        var.deployment_enabled &&
        startswith(var.project_token, "onboarding-juwon-") &&
        var.environment == "dev" &&
        local.iot_topic_root_depth == 3
      )
      error_message = "IoT/Fleet is limited to the isolated onboarding-juwon-* dev namespace and requires deployment_enabled=true."
    }

    precondition {
      condition = !var.enable_fleet_registration_guard || (
        var.enable_iot_fleet &&
        var.api_slice_enabled &&
        can(regex("^[0-9a-fA-F]{64}$", var.fleet_claim_certificate_id))
      )
      error_message = "The Fleet registration guard requires the isolated Fleet, API slice, and an exact moodlight-only claim certificate ID."
    }

    precondition {
      condition = !var.enable_backend_integrations || (
        var.deployment_enabled && var.api_slice_enabled && var.enable_iot_fleet
      )
      error_message = "Backend integrations require deployment, the API slice, and the isolated IoT fleet to be enabled together."
    }

    precondition {
      condition     = !var.enable_iot_rules || local.backend_integrations_enabled || var.ingest_lambda_arn != ""
      error_message = "IoT rules require either the opt-in local backend integrations or a confirmed deployed Ingest Lambda ARN."
    }

    precondition {
      condition = var.ingest_lambda_arn == "" || startswith(
        var.ingest_lambda_arn,
        "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.prefix}-",
      )
      error_message = "An external Ingest Lambda must be in the confirmed account, Region, and moodlight project prefix."
    }

    precondition {
      condition     = !var.enable_device_decommission || local.backend_integrations_enabled
      error_message = "Device decommissioning requires the explicitly enabled isolated backend integrations."
    }
  }
}
