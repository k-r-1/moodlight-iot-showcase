# Upstream provenance

- Repository: `espressif/esp-idf-provisioning-android`
- Tag: `lib-2.4.4`
- Commit: `b83b78543fcd7ae24c9acbefdc17cad3ed4a3607`
- Imported module: `provisioning/`

The Java/protobuf implementation is kept unchanged except for these local
compatibility and security patches:

- remove Logcat statements that print registration secrets, SoftAP Wi-Fi
  credentials, discovered SSIDs, network capabilities, or complete QR payloads;
- reject non-UTF-8 SSID bytes instead of silently displaying a replacement
  string that could name a different network;
- attach the originating `ESPDevice` to connection events so a late global
  EventBus callback cannot complete a newer device session;
- update the protobuf Gradle plugin from `0.9.1` to `0.10.0` because Gradle 9
  removed an API used by the older plugin. Generated protocol definitions and
  runtime versions are unchanged.

The Moodlight bridge exposes secure connect/ping, Wi-Fi scanning, and Wi-Fi
credential provisioning on the same Security 2 session. The call is accepted
only for the current registration attempt, request, selected device, and live
secure session. Credential values are not logged by the local bridge patches.
