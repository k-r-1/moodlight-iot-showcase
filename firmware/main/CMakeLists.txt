set(provisioning_credentials "${CMAKE_CURRENT_LIST_DIR}/../local/provisioning_credentials.h")
set(component_sources "app_main.c" "provisioning.c" "claim_binding.c" "led_controller.c" "serial_console.c")

if(NOT EXISTS "${provisioning_credentials}")
    message(FATAL_ERROR
        "Missing local provisioning credentials. Run "
        "firmware/tools/generate_provisioning_credentials.py before building.")
endif()

if(CONFIG_MOODLIGHT_FLEET_PROVISIONING)
    set(fleet_credentials "${CMAKE_CURRENT_LIST_DIR}/../local/fleet_credentials.h")
    if(NOT EXISTS "${fleet_credentials}")
        message(FATAL_ERROR
            "Fleet Provisioning is enabled but local/fleet_credentials.h is missing. Run "
            "firmware/tools/generate_fleet_credentials.py before building.")
    endif()
    list(APPEND component_sources "fleet_identity.c" "fleet_provisioning.c")
endif()

if(CONFIG_MOODLIGHT_MQTT_RUNTIME)
    list(APPEND component_sources "mqtt_runtime.c")
endif()

if(CONFIG_MOODLIGHT_MQTT_RUNTIME AND NOT CONFIG_MOODLIGHT_FLEET_PROVISIONING)
    set(mqtt_credentials "${CMAKE_CURRENT_LIST_DIR}/../local/mqtt_credentials.h")
    if(NOT EXISTS "${mqtt_credentials}")
        message(FATAL_ERROR
            "MQTT runtime is enabled but local/mqtt_credentials.h is missing. Run "
            "firmware/tools/generate_mqtt_credentials.py before building.")
    endif()
endif()

idf_component_register(SRCS ${component_sources}
                       INCLUDE_DIRS "." "../local"
                       REQUIRES console esp_driver_gpio esp_driver_ledc esp_event esp_netif esp_wifi json mbedtls nvs_flash wifi_provisioning
                       PRIV_REQUIRES esp_app_format esp_timer mqtt)
