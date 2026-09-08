#pragma once

#include "esp_err.h"

esp_err_t mqtt_runtime_start(void);
esp_err_t mqtt_runtime_start_when_network_ready(void);
