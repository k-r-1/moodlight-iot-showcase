output "resource_prefix" {
  description = "Computed resource prefix; this does not mean it is approved for deployment."
  value       = local.prefix
}

output "planned_resource_counts" {
  description = "Expected resources from the currently implemented module only."
  value = {
    dynamodb_tables = var.deployment_enabled ? length(local.table_definitions) : 0
    cognito         = local.api_slice_enabled ? 1 : 0
    api             = local.api_slice_enabled ? 1 : 0
    lambda          = (local.api_slice_enabled ? 1 : 0) + (local.backend_integrations_enabled ? 2 : 0)
    iot_fleet       = var.deployment_enabled && var.enable_iot_fleet ? 8 : 0
    iot_rules       = local.iot_rules_enabled ? 3 : 0
    scheduler       = local.backend_integrations_enabled ? 1 : 0
  }
}

output "iot_contract" {
  description = "Non-secret MQTT naming contract. Resource creation still depends on both deployment flags."
  value = {
    topic_root   = local.iot_topic_root
    thing_prefix = local.iot_thing_prefix
    uplink       = ["state", "tele", "evt"]
    downlink     = ["cmd"]
  }
}

output "dynamodb_table_names" {
  description = "Stable intended names, available even in non-deployment plans."
  value       = { for key, definition in local.table_definitions : key => definition.name }
}

output "created_dynamodb_table_arns" {
  description = "ARNs are populated only when deployment_enabled is true and tables exist."
  value       = { for key, table in aws_dynamodb_table.domain : key => table.arn }
  sensitive   = true
}

output "pending_service_inputs" {
  description = "Configured Cognito callback and logout inputs; values remain empty while the optional API slice is disabled."
  value = {
    cognito_callback_urls = var.cognito_callback_urls
    cognito_logout_urls   = var.cognito_logout_urls
  }
}

output "api_slice" {
  description = "Identifiers for the optional Cognito and HTTP API slice."
  value = local.api_slice_enabled ? {
    api_endpoint       = aws_apigatewayv2_api.http[0].api_endpoint
    cognito_user_pool  = aws_cognito_user_pool.main[0].id
    cognito_app_client = aws_cognito_user_pool_client.app[0].id
    cognito_domain     = aws_cognito_user_pool_domain.main[0].domain
  } : null
}
