variable "api_slice_enabled" {
  description = "Plans Cognito, HTTP API, and API Lambda only after their deployment values are confirmed."
  type        = bool
  default     = false
}

variable "cors_allow_origins" {
  description = "Exact browser origins allowed to call the dev HTTP API. Wildcards are forbidden."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for origin in var.cors_allow_origins :
      origin != "*" && (
        can(regex("^https://[^/[:space:]#]+(:[0-9]+)?$", origin)) ||
        can(regex("^http://localhost(:[0-9]+)?$", origin))
      )
    ])
    error_message = "CORS origins must be exact HTTPS origins or local http://localhost origins; wildcard is forbidden."
  }
}

variable "lambda_log_retention_days" {
  description = "Explicit retention for API and Lambda logs."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.lambda_log_retention_days)
    error_message = "lambda_log_retention_days must be a supported short retention value."
  }
}

locals {
  api_slice_enabled = var.deployment_enabled && var.api_slice_enabled
}
