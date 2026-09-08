#include "fleet_identity.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include "fleet_credentials.h"
#include "mbedtls/platform_util.h"
#include "nvs.h"
#include "sdkconfig.h"

#if !CONFIG_NVS_ENCRYPTION && !CONFIG_MOODLIGHT_ALLOW_PLAINTEXT_DEMO_CREDENTIALS
#error "Fleet identity storage requires encrypted NVS or the explicit plaintext demo exception"
#endif

#define FLEET_IDENTITY_NAMESPACE "fleet_id"
/* NVS strings are limited to 4,000 bytes including the terminating NUL. */
#define FLEET_CERTIFICATE_MAX_BYTES 3999
#define FLEET_PRIVATE_KEY_MAX_BYTES 3999
#define FLEET_THING_NAME_MAX_BYTES 128
/* Leaves room for the longest runtime suffix ("/state") and the terminating NUL. */
#define FLEET_TOPIC_BASE_MAX_BYTES 377

static bool valid_pem(const char *value, const char *label)
{
    return value != NULL && value[0] != '\0'
        && strstr(value, "-----BEGIN ") == value
        && strstr(value, label) != NULL
        && strstr(value, "-----END ") != NULL;
}

static bool valid_segment(const char *value, size_t length)
{
    if (length == 0 || length > 128) {
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

static bool valid_topic_base(const char *topic_base, const char *thing_name)
{
    const size_t topic_length = strlen(topic_base);
    const size_t root_length = strlen(MOODLIGHT_FLEET_TOPIC_ROOT);
    if (topic_length <= root_length || thing_name == NULL
            || strncmp(topic_base, MOODLIGHT_FLEET_TOPIC_ROOT, root_length) != 0
            || topic_base[root_length] != '/') {
        return false;
    }
    const char *tenant = topic_base + root_length + 1;
    const char *pools = strchr(tenant, '/');
    if (pools == NULL || !valid_segment(tenant, (size_t)(pools - tenant))
            || strncmp(pools, "/pools/", 7) != 0) {
        return false;
    }
    const char *pool = pools + 7;
    const char *thing = strchr(pool, '/');
    return thing != NULL && valid_segment(pool, (size_t)(thing - pool))
        && strcmp(thing + 1, thing_name) == 0;
}

static esp_err_t load_string(nvs_handle_t handle, const char *key,
                             size_t maximum, char **result)
{
    size_t length = 0;
    esp_err_t err = nvs_get_str(handle, key, NULL, &length);
    if (err != ESP_OK) {
        return err;
    }
    if (length < 2 || length > maximum + 1) {
        return ESP_ERR_INVALID_SIZE;
    }
    char *value = calloc(length, 1);
    if (value == NULL) {
        return ESP_ERR_NO_MEM;
    }
    err = nvs_get_str(handle, key, value, &length);
    if (err != ESP_OK) {
        mbedtls_platform_zeroize(value, length);
        free(value);
        return err;
    }
    *result = value;
    return ESP_OK;
}

bool fleet_identity_is_issued(void)
{
    nvs_handle_t handle;
    if (nvs_open(FLEET_IDENTITY_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }
    uint8_t issued = 0;
    const esp_err_t err = nvs_get_u8(handle, "issued", &issued);
    nvs_close(handle);
    return err == ESP_OK && issued == 1;
}

bool fleet_identity_recovery_required(void)
{
    nvs_handle_t handle;
    const esp_err_t open_err = nvs_open(FLEET_IDENTITY_NAMESPACE, NVS_READONLY,
                                        &handle);
    if (open_err == ESP_ERR_NVS_NOT_FOUND) {
        return false;
    }
    if (open_err != ESP_OK) {
        return true;
    }
    uint8_t enrollment_started = 0;
    const esp_err_t err = nvs_get_u8(handle, "enroll_started",
                                     &enrollment_started);
    nvs_close(handle);
    return err == ESP_OK ? enrollment_started == 1
                         : err != ESP_ERR_NVS_NOT_FOUND;
}

esp_err_t fleet_identity_mark_enrollment_started(void)
{
    nvs_handle_t handle;
    esp_err_t err = nvs_open(FLEET_IDENTITY_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    uint8_t issued = 0;
    const esp_err_t issued_err = nvs_get_u8(handle, "issued", &issued);
    if (issued_err == ESP_OK && issued == 1) {
        err = ESP_ERR_INVALID_STATE;
    } else if (issued_err != ESP_OK && issued_err != ESP_ERR_NVS_NOT_FOUND) {
        err = issued_err;
    } else {
        err = nvs_set_u8(handle, "enroll_started", 1);
        if (err == ESP_OK) err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

esp_err_t fleet_identity_store_issued(const char *certificate_pem,
                                      const char *private_key_pem,
                                      const char *thing_name,
                                      const char *topic_base)
{
    if (!valid_pem(certificate_pem, "CERTIFICATE")
            || !valid_pem(private_key_pem, "PRIVATE KEY")
            || strlen(certificate_pem) > FLEET_CERTIFICATE_MAX_BYTES
            || strlen(private_key_pem) > FLEET_PRIVATE_KEY_MAX_BYTES
            || thing_name == NULL || thing_name[0] == '\0'
            || strlen(thing_name) > FLEET_THING_NAME_MAX_BYTES
            || topic_base == NULL
            || strlen(topic_base) > FLEET_TOPIC_BASE_MAX_BYTES
            || !valid_topic_base(topic_base, thing_name)) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(FLEET_IDENTITY_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(handle, "certificate", certificate_pem);
    if (err == ESP_OK) err = nvs_set_str(handle, "private_key", private_key_pem);
    if (err == ESP_OK) err = nvs_set_str(handle, "thing_name", thing_name);
    if (err == ESP_OK) err = nvs_set_str(handle, "topic_base", topic_base);
    if (err == ESP_OK) err = nvs_erase_key(handle, "enroll_started");
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK) err = nvs_set_u8(handle, "issued", 1);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err;
}

esp_err_t fleet_identity_load(fleet_identity_t *identity, bool require_topic_base)
{
    if (identity == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(identity, 0, sizeof(*identity));
    nvs_handle_t handle;
    esp_err_t err = nvs_open(FLEET_IDENTITY_NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }
    uint8_t issued = 0;
    err = nvs_get_u8(handle, "issued", &issued);
    if (err == ESP_OK && issued != 1) err = ESP_ERR_INVALID_STATE;
    if (err == ESP_OK) {
        err = load_string(handle, "certificate", FLEET_CERTIFICATE_MAX_BYTES,
                          &identity->certificate_pem);
    }
    if (err == ESP_OK) {
        err = load_string(handle, "private_key", FLEET_PRIVATE_KEY_MAX_BYTES,
                          &identity->private_key_pem);
    }
    if (err == ESP_OK) {
        err = load_string(handle, "thing_name", FLEET_THING_NAME_MAX_BYTES,
                          &identity->thing_name);
    }
    if (err == ESP_OK && require_topic_base) {
        err = load_string(handle, "topic_base", FLEET_TOPIC_BASE_MAX_BYTES,
                          &identity->topic_base);
    }
    nvs_close(handle);
    if (err != ESP_OK) {
        fleet_identity_free(identity);
    }
    return err;
}

void fleet_identity_free(fleet_identity_t *identity)
{
    if (identity == NULL) {
        return;
    }
    if (identity->certificate_pem != NULL) {
        mbedtls_platform_zeroize(identity->certificate_pem,
                                 strlen(identity->certificate_pem));
        free(identity->certificate_pem);
    }
    if (identity->private_key_pem != NULL) {
        mbedtls_platform_zeroize(identity->private_key_pem,
                                 strlen(identity->private_key_pem));
        free(identity->private_key_pem);
    }
    free(identity->thing_name);
    free(identity->topic_base);
    memset(identity, 0, sizeof(*identity));
}
