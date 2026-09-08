#pragma once

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#include "esp_err.h"

#define CLAIM_BINDING_ID_CAPACITY 129
#define CLAIM_BINDING_NONCE_HASH_BYTES 32

typedef struct {
    char claim_id[CLAIM_BINDING_ID_CAPACITY];
    uint8_t registration_nonce_sha256[CLAIM_BINDING_NONCE_HASH_BYTES];
} claim_binding_t;

esp_err_t claim_binding_handle(const uint8_t *input, size_t input_len,
                               uint8_t **output, ssize_t *output_len);
esp_err_t claim_binding_load(claim_binding_t *binding);
