#include "claim_binding.h"

#include <ctype.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "mbedtls/sha256.h"
#include "nvs.h"

#define CLAIM_BINDING_MAX_REQUEST_BYTES 512
#define CLAIM_BINDING_NONCE_MAX_BYTES 256

static bool is_identifier(const char *value)
{
    if (value == NULL) {
        return false;
    }
    const size_t length = strlen(value);
    if (length == 0 || length >= CLAIM_BINDING_ID_CAPACITY) {
        return false;
    }
    for (size_t i = 0; i < length; i++) {
        const unsigned char ch = (unsigned char)value[i];
        if (!isalnum(ch) && ch != '_' && ch != '.' && ch != ':' && ch != '-') {
            return false;
        }
    }
    return true;
}

static esp_err_t store_binding(const char *claim_id, const char *registration_nonce)
{
    uint8_t nonce_hash[CLAIM_BINDING_NONCE_HASH_BYTES];
    if (mbedtls_sha256((const unsigned char *)registration_nonce,
                       strlen(registration_nonce), nonce_hash, 0) != 0) {
        return ESP_FAIL;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open("claim_binding", NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(handle, "claim_id", claim_id);
    if (err == ESP_OK) {
        err = nvs_set_blob(handle, "nonce_hash", nonce_hash, sizeof(nonce_hash));
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

static esp_err_t make_ack(const char *claim_id, uint8_t **output, ssize_t *output_len)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }
    if (cJSON_AddStringToObject(root, "type", "claim.ack") == NULL
            || cJSON_AddNumberToObject(root, "version", 1) == NULL
            || cJSON_AddStringToObject(root, "claimId", claim_id) == NULL
            || cJSON_AddStringToObject(root, "status", "accepted") == NULL) {
        cJSON_Delete(root);
        return ESP_ERR_NO_MEM;
    }
    char *encoded = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (encoded == NULL) {
        return ESP_ERR_NO_MEM;
    }
    *output = (uint8_t *)encoded;
    *output_len = (ssize_t)strlen(encoded);
    return ESP_OK;
}

esp_err_t claim_binding_handle(const uint8_t *input, size_t input_len,
                               uint8_t **output, ssize_t *output_len)
{
    if (input == NULL || output == NULL || output_len == NULL
            || input_len == 0 || input_len > CLAIM_BINDING_MAX_REQUEST_BYTES) {
        return ESP_ERR_INVALID_ARG;
    }
    *output = NULL;
    *output_len = 0;

    const char *parse_end = NULL;
    cJSON *root = cJSON_ParseWithLengthOpts((const char *)input, input_len, &parse_end, false);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }
    while (parse_end < (const char *)input + input_len && isspace((unsigned char)*parse_end)) {
        parse_end++;
    }
    if (parse_end != (const char *)input + input_len) {
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }

    enum {
        SEEN_TYPE = 1U << 0,
        SEEN_VERSION = 1U << 1,
        SEEN_CLAIM_ID = 1U << 2,
        SEEN_NONCE = 1U << 3,
    };
    uint32_t seen = 0;
    const char *claim_id = NULL;
    const char *nonce = NULL;
    cJSON *item = NULL;
    cJSON_ArrayForEach(item, root) {
        uint32_t field = 0;
        if (strcmp(item->string, "type") == 0) {
            field = SEEN_TYPE;
            if (!cJSON_IsString(item) || strcmp(item->valuestring, "claim.bind") != 0) {
                goto invalid;
            }
        } else if (strcmp(item->string, "version") == 0) {
            field = SEEN_VERSION;
            if (!cJSON_IsNumber(item) || item->valuedouble != 1) {
                goto invalid;
            }
        } else if (strcmp(item->string, "claimId") == 0) {
            field = SEEN_CLAIM_ID;
            if (!cJSON_IsString(item) || !is_identifier(item->valuestring)) {
                goto invalid;
            }
            claim_id = item->valuestring;
        } else if (strcmp(item->string, "registrationNonce") == 0) {
            field = SEEN_NONCE;
            if (!cJSON_IsString(item) || item->valuestring[0] == '\0'
                    || strlen(item->valuestring) > CLAIM_BINDING_NONCE_MAX_BYTES) {
                goto invalid;
            }
            nonce = item->valuestring;
        } else {
            goto invalid;
        }
        if ((seen & field) != 0) {
            goto invalid;
        }
        seen |= field;
    }
    if (seen != (SEEN_TYPE | SEEN_VERSION | SEEN_CLAIM_ID | SEEN_NONCE)) {
        goto invalid;
    }

    esp_err_t err = store_binding(claim_id, nonce);
    if (err == ESP_OK) {
        err = make_ack(claim_id, output, output_len);
    }
    cJSON_Delete(root);
    return err;

invalid:
    cJSON_Delete(root);
    return ESP_ERR_INVALID_ARG;
}

esp_err_t claim_binding_load(claim_binding_t *binding)
{
    if (binding == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    esp_err_t err = nvs_open("claim_binding", NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }
    size_t claim_id_size = sizeof(binding->claim_id);
    size_t nonce_hash_size = sizeof(binding->registration_nonce_sha256);
    err = nvs_get_str(handle, "claim_id", binding->claim_id, &claim_id_size);
    if (err == ESP_OK) {
        err = nvs_get_blob(handle, "nonce_hash", binding->registration_nonce_sha256,
                           &nonce_hash_size);
    }
    nvs_close(handle);
    if (err == ESP_OK && nonce_hash_size != CLAIM_BINDING_NONCE_HASH_BYTES) {
        return ESP_ERR_INVALID_SIZE;
    }
    return err;
}
