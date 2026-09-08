variable "project_token" {
  description = "Company-approved lowercase project token. The default is deliberately not deployable."
  type        = string
  default     = "unconfirmed"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,39}$", var.project_token))
    error_message = "project_token must be 3-40 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "environment" {
  description = "Company-approved environment token."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,11}$", var.environment))
    error_message = "environment must be 2-12 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "aws_region" {
  description = "Single AWS Region approved for this environment."
  type        = string
  default     = "ap-northeast-2"

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must look like a valid AWS Region name."
  }
}

variable "aws_account_id" {
  description = "Twelve-digit AWS account allowed for deployment. Empty while deployment is disabled."
  type        = string
  default     = ""

  validation {
    condition     = var.aws_account_id == "" || can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be empty or exactly 12 digits."
  }
}

variable "owner_tag" {
  description = "Company-approved owner/cost attribution tag."
  type        = string
  default     = "unconfirmed"

  validation {
    condition     = length(trimspace(var.owner_tag)) >= 2 && length(var.owner_tag) <= 128
    error_message = "owner_tag must contain 2-128 characters."
  }
}

variable "deployment_enabled" {
  description = "Creates AWS resources only when true. Keep false for local validation."
  type        = bool
  default     = false
}

variable "company_values_confirmed" {
  description = "Set true only after company confirms project, account, Region, naming, and tags."
  type        = bool
  default     = false
}

variable "cognito_callback_urls" {
  description = "Reserved for the future Cognito app client; validated now but not yet consumed."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for url in var.cognito_callback_urls :
      can(regex("^https://[^[:space:]#]+$", url)) ||
      can(regex("^http://localhost(:[0-9]+)?(/[^[:space:]#]*)?$", url)) ||
      (!startswith(url, "http://") && !startswith(url, "https://") && can(regex("^[a-z][a-z0-9+.-]+://[^[:space:]#]+$", url)))
    ])
    error_message = "Callback URLs must be absolute HTTPS, local http://localhost, or an explicit lowercase app URI; fragments are not allowed."
  }
}

variable "cognito_logout_urls" {
  description = "Reserved for the future Cognito app client; validated now but not yet consumed."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for url in var.cognito_logout_urls :
      can(regex("^https://[^[:space:]#]+$", url)) ||
      can(regex("^http://localhost(:[0-9]+)?(/[^[:space:]#]*)?$", url)) ||
      (!startswith(url, "http://") && !startswith(url, "https://") && can(regex("^[a-z][a-z0-9+.-]+://[^[:space:]#]+$", url)))
    ])
    error_message = "Logout URLs must be absolute HTTPS, local http://localhost, or an explicit lowercase app URI; fragments are not allowed."
  }
}

variable "additional_tags" {
  description = "Additional company tags; reserved common tag keys cannot be overridden."
  type        = map(string)
  default     = {}

  validation {
    condition = length(setintersection(
      toset(keys(var.additional_tags)),
      toset(["Project", "Environment", "ManagedBy", "Owner"])
    )) == 0
    error_message = "additional_tags cannot override Project, Environment, ManagedBy, or Owner."
  }
}

variable "enable_point_in_time_recovery" {
  description = "Enable DynamoDB PITR. Disabling it requires an explicit input change."
  type        = bool
  default     = true
}

variable "enable_deletion_protection" {
  description = "Enable DynamoDB deletion protection. Terraform prevent_destroy also remains enabled."
  type        = bool
  default     = true
}

variable "enable_iot_fleet" {
  description = "Create the isolated IoT Thing type/group, claim/bootstrap/runtime policies, provisioning role, and Fleet template."
  type        = bool
  default     = false
}

variable "enable_fleet_registration_guard" {
  description = "Create the isolated manufacturing registry and Fleet pre-provisioning hook. Keep false until registry seeding and a dedicated claim certificate are approved."
  type        = bool
  default     = false
}

variable "fleet_claim_certificate_id" {
  description = "Exact ID of the moodlight-only Fleet claim certificate accepted by the pre-provisioning hook. It is not a private key."
  type        = string
  default     = ""

  validation {
    condition     = var.fleet_claim_certificate_id == "" || can(regex("^[0-9a-fA-F]{64}$", var.fleet_claim_certificate_id))
    error_message = "fleet_claim_certificate_id must be empty or an exact 64-character hexadecimal certificate ID."
  }
}

variable "enable_iot_rules" {
  description = "Create MQTT-to-Ingest rules only after the deployed Ingest Lambda ARN is confirmed."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_iot_rules || var.enable_iot_fleet
    error_message = "enable_iot_rules requires enable_iot_fleet=true."
  }
}

variable "enable_device_decommission" {
  description = "Opt in to certificate and Thing cleanup only after the account-wide certificate scope is explicitly approved."
  type        = bool
  default     = false
}

variable "ingest_lambda_arn" {
  description = "Confirmed Ingest Lambda ARN. Empty until the Lambda is deployed."
  type        = string
  default     = ""

  validation {
    condition     = var.ingest_lambda_arn == "" || can(regex("^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9-_]+$", var.ingest_lambda_arn))
    error_message = "ingest_lambda_arn must be empty or a Lambda function ARN without an alias."
  }
}
