locals {
  prefix = "openiot-${var.project_token}-${var.environment}"

  # One AWS account/Region has one IoT data endpoint. A unique first topic
  # segment and Thing prefix keep this lab outside every company project tree.
  iot_topic_root       = "${var.project_token}/${var.environment}/tenants"
  iot_topic_root_depth = length(split("/", local.iot_topic_root))
  iot_thing_prefix     = "${local.prefix}-lamp-"
  iot_thing_variable   = "$${iot:Connection.Thing.ThingName}"
  iot_tenant_variable  = "$${iot:Connection.Thing.Attributes[tenant_id]}"
  iot_pool_variable    = "$${iot:Connection.Thing.Attributes[pool_id]}"
  iot_device_base      = "${local.iot_topic_root}/${local.iot_tenant_variable}/pools/${local.iot_pool_variable}/${local.iot_thing_variable}"

  common_tags = merge(var.additional_tags, {
    Project     = var.project_token
    Environment = var.environment
    ManagedBy   = "terraform"
    Owner       = var.owner_tag
  })

  table_definitions = {
    tenant = {
      name       = "${local.prefix}-tenant"
      hash_key   = "tenantId"
      range_key  = null
      attributes = { tenantId = "S" }
    }
    membership = {
      name       = "${local.prefix}-membership"
      hash_key   = "userId"
      range_key  = "tenantId"
      attributes = { userId = "S", tenantId = "S" }
    }
    pool = {
      name       = "${local.prefix}-pool"
      hash_key   = "tenantId"
      range_key  = "poolId"
      attributes = { tenantId = "S", poolId = "S" }
    }
    device = {
      name       = "${local.prefix}-device"
      hash_key   = "deviceId"
      range_key  = null
      attributes = { deviceId = "S", tenantId = "S", tenantPoolKey = "S" }
    }
    device_claim = {
      name       = "${local.prefix}-device-claim"
      hash_key   = "claimKey"
      range_key  = null
      attributes = { claimKey = "S" }
    }
    preset = {
      name       = "${local.prefix}-preset"
      hash_key   = "tenantId"
      range_key  = "presetId"
      attributes = { tenantId = "S", presetId = "S" }
    }
    schedule = {
      name       = "${local.prefix}-schedule"
      hash_key   = "tenantId"
      range_key  = "scheduleId"
      attributes = { tenantId = "S", scheduleId = "S" }
    }
  }
}
