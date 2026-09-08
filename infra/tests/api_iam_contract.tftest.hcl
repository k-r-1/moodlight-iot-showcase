mock_provider "aws" {
  override_during = plan
}
mock_provider "archive" {}

run "api_transaction_permissions" {
  command = plan

  variables {
    project_token               = "moodlight-demo-test-m4d2"
    environment                 = "dev"
    aws_account_id              = "123456789012"
    owner_tag                   = "demo-owner"
    deployment_enabled          = true
    deployment_values_confirmed = true
    api_slice_enabled           = true
    cognito_callback_urls       = ["openiot-moodlight://auth/callback"]
    cognito_logout_urls         = ["openiot-moodlight://auth/logout"]
    cors_allow_origins          = ["http://localhost:3210"]
  }

  assert {
    condition = contains(
      local.api_dynamodb_actions.device,
      "dynamodb:PutItem",
    )
    error_message = "The API Lambda must be allowed to put the Device created by the finalize transaction."
  }

  assert {
    condition = !contains(
      flatten(values(local.api_dynamodb_actions)),
      "dynamodb:TransactWriteItems",
    )
    error_message = "DynamoDB transactions must use their underlying PutItem and UpdateItem IAM actions."
  }
}
