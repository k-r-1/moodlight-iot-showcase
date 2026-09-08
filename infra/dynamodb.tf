resource "aws_dynamodb_table" "domain" {
  for_each = var.deployment_enabled ? local.table_definitions : {}

  name         = each.value.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = each.value.hash_key
  range_key    = each.value.range_key

  deletion_protection_enabled = var.enable_deletion_protection

  dynamic "attribute" {
    for_each = each.value.attributes
    content {
      name = attribute.key
      type = attribute.value
    }
  }

  dynamic "attribute" {
    for_each = each.key == "schedule" && local.backend_integrations_enabled ? { syncStatus = "S", updatedAt = "S" } : {}
    content {
      name = attribute.key
      type = attribute.value
    }
  }

  dynamic "global_secondary_index" {
    for_each = each.key == "device" ? [1] : []
    content {
      name            = "tenant-pool-devices-index"
      hash_key        = "tenantId"
      range_key       = "tenantPoolKey"
      projection_type = "KEYS_ONLY"
    }
  }

  dynamic "global_secondary_index" {
    for_each = each.key == "schedule" && local.backend_integrations_enabled ? [1] : []
    content {
      name            = "sync-status-updated-index"
      hash_key        = "syncStatus"
      range_key       = "updatedAt"
      projection_type = "ALL"
    }
  }

  dynamic "ttl" {
    for_each = each.key == "device_claim" || (each.key == "device" && local.backend_integrations_enabled) ? [1] : []
    content {
      attribute_name = "expiresAt"
      enabled        = true
    }
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [terraform_data.deployment_guard]
}
