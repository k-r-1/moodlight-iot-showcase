package com.openiot.moodlight.provisioning

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.espressif.provisioning.DeviceConnectionEvent
import com.espressif.provisioning.ESPConstants
import com.espressif.provisioning.ESPDevice
import com.espressif.provisioning.listeners.ResponseListener
import com.espressif.provisioning.listeners.ProvisionListener
import com.espressif.provisioning.listeners.WiFiScanListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.greenrobot.eventbus.EventBus
import org.greenrobot.eventbus.Subscribe
import org.greenrobot.eventbus.ThreadMode
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.UUID

private const val CONNECT_TIMEOUT_MS = 20_000L
private const val QR_TIMEOUT_MS = 60_000L
private const val WIFI_SCAN_TIMEOUT_MS = 20_000L
private const val CLAIM_BIND_TIMEOUT_MS = 15_000L
private const val WIFI_PROVISION_TIMEOUT_MS = 60_000L
private const val CUSTOM_ENDPOINT = "custom-data"
private val PING = "ping".toByteArray(StandardCharsets.UTF_8)
private val PONG = "pong".toByteArray(StandardCharsets.UTF_8)
private val ANDROID_DEVICE_ID = Regex("^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$")
private val CLAIM_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
private val REGISTRATION_NONCE = Regex("^[A-Za-z0-9_-]{16,512}$")

class MoodlightSecureProvisioningModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var device: ESPDevice? = null
  private var connectedDeviceId: String? = null
  private var productRegistration: ProductRegistration? = null
  private var pendingPromise: Promise? = null
  private var timeout: Runnable? = null
  private var wifiScanPromise: Promise? = null
  private var wifiScanTimeout: Runnable? = null
  private var claimBindPromise: Promise? = null
  private var claimBindTimeout: Runnable? = null
  private var claimBindingRequired = false
  private var boundClaimId: String? = null
  private var wifiProvisionPromise: Promise? = null
  private var wifiProvisionTimeout: Runnable? = null
  private var eventBusRegistered = false
  private var generation = 0L

  override fun definition() = ModuleDefinition {
    Name("MoodlightSecureProvisioning")

    AsyncFunction("scanQrAndConnectAndPing") {
        deviceId: String,
        expectedDeviceName: String,
        primaryServiceUuid: String,
        promise: Promise ->
      scanQrAndConnectAndPing(deviceId, expectedDeviceName, primaryServiceUuid, promise)
    }

    AsyncFunction("disconnect") {
      disconnect("DISCONNECTED", "기기 연결을 해제했습니다.")
    }

    AsyncFunction("bindDeviceClaim") {
        deviceId: String,
        claimId: String,
        registrationNonce: String,
        promise: Promise ->
      bindDeviceClaim(deviceId, claimId, registrationNonce, promise)
    }

    AsyncFunction("scanWifiNetworks") { promise: Promise ->
      scanWifiNetworks(promise)
    }

    AsyncFunction("provisionWifi") { deviceId: String, ssid: String, password: String, promise: Promise ->
      provisionWifi(deviceId, ssid, password, promise)
    }

    OnDestroy {
      disconnect("MODULE_DESTROYED", "네이티브 모듈이 종료되었습니다.")
    }
  }

  @Subscribe(threadMode = ThreadMode.MAIN)
  fun onDeviceConnectionEvent(event: DeviceConnectionEvent) {
    val current = device ?: return
    val promise = pendingPromise ?: return
    if (event.source !== current) return
    val operation = generation
    when (event.eventType) {
      ESPConstants.EVENT_DEVICE_CONNECTED -> sendPing(operation, promise, current)
      ESPConstants.EVENT_DEVICE_CONNECTION_FAILED ->
        fail(operation, promise, "BLE_CONNECT_FAILED", "기기에 안전하게 연결하지 못했습니다.")
      ESPConstants.EVENT_DEVICE_DISCONNECTED ->
        fail(operation, promise, "BLE_DISCONNECTED", "기기 연결이 끊겼습니다.")
    }
  }

  private fun scanQrAndConnectAndPing(
    deviceId: String,
    expectedDeviceName: String,
    primaryServiceUuid: String,
    promise: Promise,
  ) {
    if (pendingPromise != null || device != null) {
      promise.reject("BLE_BUSY", "다른 기기 작업이 진행 중입니다.", null)
      return
    }
    if (!ANDROID_DEVICE_ID.matches(deviceId)) {
      promise.reject("INVALID_DEVICE_ID", "Android BLE 기기 식별자 형식이 올바르지 않습니다.", null)
      return
    }
    try {
      UUID.fromString(primaryServiceUuid)
    } catch (_: IllegalArgumentException) {
      promise.reject("INVALID_SERVICE_UUID", "BLE 서비스 UUID 형식이 올바르지 않습니다.", null)
      return
    }
    val context = appContext.reactContext
    if (context == null) {
      promise.reject("APP_CONTEXT_LOST", "앱 컨텍스트를 사용할 수 없습니다.", null)
      return
    }
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
    ) {
      promise.reject("BLE_PERMISSION_REQUIRED", "Bluetooth 연결 권한이 필요합니다.", null)
      return
    }

    val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val adapter = bluetoothManager?.adapter
    if (adapter == null || !adapter.isEnabled) {
      promise.reject("BLE_UNAVAILABLE", "Bluetooth를 사용할 수 없습니다.", null)
      return
    }

    try {
      adapter.getRemoteDevice(deviceId)
    } catch (_: IllegalArgumentException) {
      promise.reject("INVALID_DEVICE_ID", "Android BLE 기기 식별자 형식이 올바르지 않습니다.", null)
      return
    }

    val activity = appContext.currentActivity
    if (activity == null) {
      promise.reject("ACTIVITY_UNAVAILABLE", "QR 화면을 열 수 없습니다.", null)
      return
    }

    val operation = ++generation
    pendingPromise = promise
    if (!ProvisioningQrSession.begin(
        success = { credentials ->
          mainHandler.post {
            connectAndPing(operation, promise, deviceId, expectedDeviceName, primaryServiceUuid, credentials)
          }
        },
        failure = { code, message ->
          mainHandler.post { fail(operation, promise, code, message) }
        },
      )) {
        pendingPromise = null
        promise.reject("BLE_BUSY", "다른 QR 작업이 진행 중입니다.", null)
      return
    }
    armTimeout(operation, promise, QR_TIMEOUT_MS, "QR_TIMEOUT", "QR 읽기 시간이 초과되었습니다.")
    mainHandler.post {
      if (!isCurrent(operation, promise)) return@post
      try {
        activity.startActivity(Intent(activity, ProvisioningQrActivity::class.java))
      } catch (_: Exception) {
        fail(operation, promise, "QR_UNAVAILABLE", "QR 화면을 열 수 없습니다.")
      }
    }
  }

  private fun connectAndPing(
    operation: Long,
    promise: Promise,
    deviceId: String,
    expectedDeviceName: String,
    primaryServiceUuid: String,
    credentials: Security2QrCredentials,
  ) {
    if (!isCurrent(operation, promise)) return
    val context = appContext.reactContext ?: run {
      fail(operation, promise, "APP_CONTEXT_LOST", "앱 컨텍스트를 사용할 수 없습니다.")
      return
    }
    val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val adapter = bluetoothManager?.adapter
    val bluetoothDevice = try {
      adapter?.getRemoteDevice(deviceId)
    } catch (_: IllegalArgumentException) {
      null
    }
    if (bluetoothDevice == null || adapter?.isEnabled != true) {
      fail(operation, promise, "BLE_UNAVAILABLE", "Bluetooth를 사용할 수 없습니다.")
      return
    }
    val advertisedName = expectedDeviceName.ifBlank { bluetoothDevice.name.orEmpty() }
    if (advertisedName != credentials.name) {
      fail(operation, promise, "QR_DEVICE_MISMATCH", "선택한 기기와 등록 QR이 일치하지 않습니다.")
      return
    }

    val espDevice = ESPDevice(
      context.applicationContext,
      ESPConstants.TransportType.TRANSPORT_BLE,
      ESPConstants.SecurityType.SECURITY_2,
    ).apply {
      setDeviceName(credentials.name)
      setUserName(credentials.username)
      setProofOfPossession(credentials.password)
    }

    timeout?.let(mainHandler::removeCallbacks)
    productRegistration = credentials.productRegistration
    claimBindingRequired = credentials.productRegistration != null
    boundClaimId = null
    device = espDevice
    connectedDeviceId = deviceId
    registerEventBus()
    armTimeout(operation, promise, CONNECT_TIMEOUT_MS, "BLE_TIMEOUT", "Security 2 연결 확인 시간이 초과되었습니다.")
    mainHandler.post {
      if (isCurrent(operation, promise, espDevice)) {
        espDevice.connectBLEDevice(bluetoothDevice, primaryServiceUuid)
      }
    }
  }

  private fun armTimeout(operation: Long, promise: Promise, delayMs: Long, code: String, message: String) {
    timeout?.let(mainHandler::removeCallbacks)
    timeout = Runnable { fail(operation, promise, code, message) }
      .also { mainHandler.postDelayed(it, delayMs) }
  }

  private fun sendPing(operation: Long, promise: Promise, current: ESPDevice) {
    if (!isCurrent(operation, promise, current)) return
    current.sendDataToCustomEndPoint(CUSTOM_ENDPOINT, PING, object : ResponseListener {
      override fun onSuccess(returnData: ByteArray?) {
        mainHandler.post {
          if (!isCurrent(operation, promise, current)) return@post
          if (returnData?.contentEquals(PONG) == true) {
            succeed(operation, promise, current)
          } else {
            fail(operation, promise, "PING_RESPONSE_INVALID", "기기의 보안 응답을 확인하지 못했습니다.")
          }
        }
      }

      override fun onFailure(e: Exception?) {
        mainHandler.post {
          fail(operation, promise, "SECURITY2_FAILED", "Security 2 세션을 만들지 못했습니다.")
        }
      }
    })
  }

  private fun bindDeviceClaim(
    deviceId: String,
    claimId: String,
    registrationNonce: String,
    promise: Promise,
  ) {
    val current = device
    if (current == null || pendingPromise != null || connectedDeviceId != deviceId) {
      promise.reject("CLAIM_BIND_SESSION_MISMATCH", "현재 기기 보안 연결에서 등록을 다시 시작해주세요.", null)
      return
    }
    if (!claimBindingRequired) {
      promise.reject("CLAIM_BIND_NOT_REQUIRED", "로컬 시험 기기에는 서버 Claim을 전달하지 않습니다.", null)
      return
    }
    if (!CLAIM_ID.matches(claimId) || !REGISTRATION_NONCE.matches(registrationNonce)) {
      promise.reject("INVALID_CLAIM_BINDING", "서버 기기 등록 정보 형식이 올바르지 않습니다.", null)
      return
    }
    boundClaimId?.let { existing ->
      if (existing == claimId) promise.resolve(mapOf("status" to "acknowledged"))
      else promise.reject("CLAIM_ALREADY_BOUND", "현재 보안 연결은 다른 Claim에 결속되어 있습니다.", null)
      return
    }
    if (claimBindPromise != null || wifiScanPromise != null || wifiProvisionPromise != null) {
      promise.reject("CLAIM_BIND_BUSY", "다른 기기 작업이 진행 중입니다.", null)
      return
    }

    val operation = generation
    val requestData = JSONObject()
      .put("type", "claim.bind")
      .put("version", 1)
      .put("claimId", claimId)
      .put("registrationNonce", registrationNonce)
      .toString()
      .toByteArray(StandardCharsets.UTF_8)
    claimBindPromise = promise
    claimBindTimeout = Runnable {
      failClaimBind(operation, promise, current, "CLAIM_BIND_TIMEOUT", "기기 등록 정보 확인 시간이 초과되었습니다.")
    }.also { mainHandler.postDelayed(it, CLAIM_BIND_TIMEOUT_MS) }

    try {
      current.sendDataToCustomEndPoint(CUSTOM_ENDPOINT, requestData, object : ResponseListener {
        override fun onSuccess(returnData: ByteArray?) {
          mainHandler.post {
            if (!isCurrentClaimBind(operation, promise, current)) return@post
            if (!claimAckMatches(returnData, claimId)) {
              failClaimBind(operation, promise, current, "CLAIM_BIND_ACK_INVALID", "기기의 등록 확인 응답이 올바르지 않습니다.")
              return@post
            }
            claimBindPromise = null
            claimBindTimeout?.let(mainHandler::removeCallbacks)
            claimBindTimeout = null
            boundClaimId = claimId
            promise.resolve(mapOf("status" to "acknowledged"))
          }
        }

        override fun onFailure(e: Exception?) {
          mainHandler.post {
            failClaimBind(operation, promise, current, "CLAIM_BIND_SEND_FAILED", "기기에 등록 정보를 전달하지 못했습니다.")
          }
        }
      })
    } catch (_: Exception) {
      failClaimBind(operation, promise, current, "CLAIM_BIND_SEND_FAILED", "기기에 등록 정보를 전달하지 못했습니다.")
    }
  }

  private fun claimAckMatches(data: ByteArray?, claimId: String): Boolean {
    if (data == null || data.size !in 1..1024) return false
    return try {
      val json = JSONObject(String(data, StandardCharsets.UTF_8))
      val fields = mutableSetOf<String>()
      val keys = json.keys()
      while (keys.hasNext()) fields += keys.next()
      val version = json.get("version")
      fields == setOf("type", "version", "claimId", "status") &&
        json.get("type") == "claim.ack" &&
        version is Number && version.toDouble() == 1.0 &&
        json.get("claimId") == claimId &&
        json.get("status") == "accepted"
    } catch (_: Exception) {
      false
    }
  }

  private fun failClaimBind(
    operation: Long,
    promise: Promise,
    current: ESPDevice,
    code: String,
    message: String,
  ) {
    if (!isCurrentClaimBind(operation, promise, current)) return
    claimBindPromise = null
    claimBindTimeout?.let(mainHandler::removeCallbacks)
    claimBindTimeout = null
    cleanup()
    promise.reject(code, message, null)
  }

  private fun scanWifiNetworks(promise: Promise) {
    val current = device
    if (current == null || pendingPromise != null) {
      promise.reject("SECURE_SESSION_REQUIRED", "먼저 기기 보안 연결을 완료해주세요.", null)
      return
    }
    if (claimBindPromise != null || wifiScanPromise != null || wifiProvisionPromise != null) {
      promise.reject("WIFI_SCAN_BUSY", "Wi-Fi 목록을 확인하고 있습니다.", null)
      return
    }

    val operation = generation
    wifiScanPromise = promise
    wifiScanTimeout = Runnable {
      failWifiScan(operation, promise, current, "WIFI_SCAN_TIMEOUT", "Wi-Fi 목록 확인 시간이 초과되었습니다.")
    }.also { mainHandler.postDelayed(it, WIFI_SCAN_TIMEOUT_MS) }

    try {
      current.scanNetworks(object : WiFiScanListener {
        override fun onWifiListReceived(wifiList: java.util.ArrayList<com.espressif.provisioning.WiFiAccessPoint>) {
          mainHandler.post {
            if (!isCurrentWifiScan(operation, promise, current)) return@post
            val networks = wifiList
              .mapNotNull { accessPoint ->
                val ssid = accessPoint.wifiName.orEmpty()
                if (ssid.isEmpty() || ssid.toByteArray(StandardCharsets.UTF_8).size > 32) null
                else mapOf(
                  "ssid" to ssid,
                  "rssi" to accessPoint.rssi,
                  "secure" to (accessPoint.security != 0),
                )
              }
              .sortedByDescending { it["rssi"] as Int }
              .distinctBy { it["ssid"] as String }
            succeedWifiScan(operation, promise, current, networks)
          }
        }

        override fun onWiFiScanFailed(e: Exception?) {
          mainHandler.post {
            failWifiScan(operation, promise, current, "WIFI_SCAN_FAILED", "기기에서 Wi-Fi 목록을 가져오지 못했습니다.")
          }
        }
      })
    } catch (_: Exception) {
      failWifiScan(operation, promise, current, "WIFI_SCAN_FAILED", "기기에서 Wi-Fi 목록을 가져오지 못했습니다.")
    }
  }

  private fun provisionWifi(deviceId: String, ssid: String, password: String, promise: Promise) {
    val current = device
    if (current == null || pendingPromise != null || connectedDeviceId != deviceId) {
      promise.reject("SECURE_SESSION_REQUIRED", "먼저 현재 기기의 보안 연결을 완료해주세요.", null)
      return
    }
    if (claimBindingRequired && boundClaimId == null) {
      promise.reject("CLAIM_BIND_REQUIRED", "기기 등록 정보 확인을 먼저 완료해주세요.", null)
      return
    }
    if (claimBindPromise != null || wifiScanPromise != null || wifiProvisionPromise != null) {
      promise.reject("WIFI_PROVISION_BUSY", "다른 Wi-Fi 작업이 진행 중입니다.", null)
      return
    }
    val ssidBytes = ssid.toByteArray(StandardCharsets.UTF_8).size
    val passwordBytes = password.toByteArray(StandardCharsets.UTF_8).size
    if (ssidBytes !in 1..32 || passwordBytes !in 0..64) {
      promise.reject("INVALID_WIFI_CREDENTIALS", "Wi-Fi 이름 또는 비밀번호 형식이 올바르지 않습니다.", null)
      return
    }

    val operation = generation
    wifiProvisionPromise = promise
    wifiProvisionTimeout = Runnable {
      failWifiProvision(operation, promise, current, "WIFI_PROVISION_TIMEOUT", "Wi-Fi 연결 확인 시간이 초과되었습니다.")
    }.also { mainHandler.postDelayed(it, WIFI_PROVISION_TIMEOUT_MS) }

    try {
      current.provision(ssid, password, object : ProvisionListener {
        override fun createSessionFailed(e: Exception?) = failOnMain(operation, promise, current, "SECURITY2_FAILED", "기기 보안 세션을 사용할 수 없습니다.")
        override fun wifiConfigSent() = Unit
        override fun wifiConfigFailed(e: Exception?) = failOnMain(operation, promise, current, "WIFI_CONFIG_SEND_FAILED", "Wi-Fi 정보를 기기에 전달하지 못했습니다.")
        override fun wifiConfigApplied() = Unit
        override fun wifiConfigApplyFailed(e: Exception?) = failOnMain(operation, promise, current, "WIFI_CONFIG_APPLY_FAILED", "기기가 Wi-Fi 설정을 적용하지 못했습니다.")
        override fun provisioningFailedFromDevice(reason: ESPConstants.ProvisionFailureReason?) {
          val result = when (reason) {
            ESPConstants.ProvisionFailureReason.AUTH_FAILED -> "WIFI_AUTH_FAILED" to "Wi-Fi 비밀번호를 확인해주세요."
            ESPConstants.ProvisionFailureReason.NETWORK_NOT_FOUND -> "WIFI_NOT_FOUND" to "선택한 Wi-Fi를 찾지 못했습니다."
            ESPConstants.ProvisionFailureReason.DEVICE_DISCONNECTED -> "BLE_DISCONNECTED" to "Wi-Fi 연결 확인 중 기기 연결이 끊겼습니다."
            else -> "WIFI_PROVISION_FAILED" to "기기가 Wi-Fi에 연결되지 못했습니다."
          }
          failOnMain(operation, promise, current, result.first, result.second)
        }
        override fun deviceProvisioningSuccess() {
          mainHandler.post { succeedWifiProvision(operation, promise, current) }
        }
        override fun onProvisioningFailed(e: Exception?) = failOnMain(operation, promise, current, "WIFI_PROVISION_FAILED", "기기가 Wi-Fi에 연결되지 못했습니다.")
      })
    } catch (_: Exception) {
      failOnMain(operation, promise, current, "WIFI_PROVISION_FAILED", "기기가 Wi-Fi에 연결되지 못했습니다.")
    }
  }

  private fun failOnMain(
    operation: Long,
    promise: Promise,
    current: ESPDevice,
    code: String,
    message: String,
  ) {
    mainHandler.post { failWifiProvision(operation, promise, current, code, message) }
  }

  private fun succeedWifiProvision(operation: Long, promise: Promise, current: ESPDevice) {
    if (!isCurrentWifiProvision(operation, promise, current)) return
    wifiProvisionPromise = null
    wifiProvisionTimeout?.let(mainHandler::removeCallbacks)
    wifiProvisionTimeout = null
    unregisterEventBus()
    current.setUserName("")
    current.setProofOfPossession("")
    current.disconnectDevice()
    device = null
    connectedDeviceId = null
    claimBindingRequired = false
    boundClaimId = null
    generation++
    promise.resolve(mapOf("status" to "connected"))
  }

  private fun failWifiProvision(
    operation: Long,
    promise: Promise,
    current: ESPDevice,
    code: String,
    message: String,
  ) {
    if (!isCurrentWifiProvision(operation, promise, current)) return
    wifiProvisionPromise = null
    wifiProvisionTimeout?.let(mainHandler::removeCallbacks)
    wifiProvisionTimeout = null
    cleanup()
    promise.reject(code, message, null)
  }

  private fun succeed(operation: Long, promise: Promise, current: ESPDevice) {
    if (!isCurrent(operation, promise, current)) return
    pendingPromise = null
    ProvisioningQrSession.abandon()
    timeout?.let(mainHandler::removeCallbacks)
    timeout = null
    unregisterEventBus()
    val registration = productRegistration
    productRegistration = null
    promise.resolve(if (registration == null) {
      mapOf("reply" to "pong", "mode" to "test")
    } else {
      mapOf(
        "reply" to "pong",
        "mode" to "product",
        "serial" to registration.serial,
        "registrationCode" to registration.registrationCode,
      )
    })
  }

  private fun fail(operation: Long, promise: Promise, code: String, message: String) {
    if (!isCurrent(operation, promise)) return
    pendingPromise = null
    cleanup()
    promise.reject(code, message, null)
  }

  private fun disconnect(code: String, message: String) {
    val promise = pendingPromise
    if (promise != null) fail(generation, promise, code, message) else cleanup()
  }

  private fun succeedWifiScan(
    operation: Long,
    promise: Promise,
    current: ESPDevice,
    networks: List<Map<String, Any>>,
  ) {
    if (!isCurrentWifiScan(operation, promise, current)) return
    wifiScanPromise = null
    wifiScanTimeout?.let(mainHandler::removeCallbacks)
    wifiScanTimeout = null
    promise.resolve(networks)
  }

  private fun failWifiScan(
    operation: Long,
    promise: Promise,
    current: ESPDevice,
    code: String,
    message: String,
  ) {
    if (!isCurrentWifiScan(operation, promise, current)) return
    wifiScanPromise = null
    wifiScanTimeout?.let(mainHandler::removeCallbacks)
    wifiScanTimeout = null
    cleanup()
    promise.reject(code, message, null)
  }

  private fun isCurrent(operation: Long, promise: Promise, current: ESPDevice? = device): Boolean =
    generation == operation && pendingPromise === promise && device === current

  private fun isCurrentClaimBind(operation: Long, promise: Promise, current: ESPDevice): Boolean =
    generation == operation && claimBindPromise === promise && device === current

  private fun isCurrentWifiScan(operation: Long, promise: Promise, current: ESPDevice): Boolean =
    generation == operation && wifiScanPromise === promise && device === current

  private fun isCurrentWifiProvision(operation: Long, promise: Promise, current: ESPDevice): Boolean =
    generation == operation && wifiProvisionPromise === promise && device === current

  private fun cleanup() {
    generation++
    ProvisioningQrSession.abandon()
    timeout?.let(mainHandler::removeCallbacks)
    timeout = null
    claimBindPromise?.let { promise ->
      claimBindPromise = null
      claimBindTimeout?.let(mainHandler::removeCallbacks)
      claimBindTimeout = null
      promise.reject("BLE_DISCONNECTED", "기기 연결이 끊겼습니다.", null)
    }
    wifiScanPromise?.let { promise ->
      wifiScanPromise = null
      wifiScanTimeout?.let(mainHandler::removeCallbacks)
      wifiScanTimeout = null
      promise.reject("BLE_DISCONNECTED", "기기 연결이 끊겼습니다.", null)
    }
    wifiProvisionPromise?.let { promise ->
      wifiProvisionPromise = null
      wifiProvisionTimeout?.let(mainHandler::removeCallbacks)
      wifiProvisionTimeout = null
      promise.reject("BLE_DISCONNECTED", "기기 연결이 끊겼습니다.", null)
    }
    unregisterEventBus()
    device?.apply {
      setUserName("")
      setProofOfPossession("")
      disconnectDevice()
    }
    device = null
    connectedDeviceId = null
    productRegistration = null
    claimBindingRequired = false
    boundClaimId = null
  }

  private fun registerEventBus() {
    if (!eventBusRegistered) {
      EventBus.getDefault().register(this)
      eventBusRegistered = true
    }
  }

  private fun unregisterEventBus() {
    if (eventBusRegistered) {
      EventBus.getDefault().unregister(this)
      eventBusRegistered = false
    }
  }
}
