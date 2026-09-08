#pragma once

#include <stdbool.h>

#include "esp_err.h"

typedef struct {
    char *certificate_pem;
    char *private_key_pem;
    char *thing_name;
    char *topic_base;
} fleet_identity_t;

bool fleet_identity_is_issued(void);
bool fleet_identity_recovery_required(void);
esp_err_t fleet_identity_mark_enrollment_started(void);
esp_err_t fleet_identity_store_issued(const char *certificate_pem,
                                      const char *private_key_pem,
                                      const char *thing_name,
                                      const char *topic_base);
esp_err_t fleet_identity_load(fleet_identity_t *identity, bool require_topic_base);
void fleet_identity_free(fleet_identity_t *identity);
