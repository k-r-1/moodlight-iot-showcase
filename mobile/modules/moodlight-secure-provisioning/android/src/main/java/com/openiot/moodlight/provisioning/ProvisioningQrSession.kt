package com.openiot.moodlight.provisioning

import java.lang.ref.WeakReference

internal data class ProductRegistration(
  val serial: String,
  val registrationCode: String,
)

internal data class Security2QrCredentials(
  val name: String,
  val username: String,
  val password: String,
  val productRegistration: ProductRegistration? = null,
)

/**
 * One in-memory handoff. The raw QR and Security 2 password stay in Kotlin.
 * Validated product identity may reach the Native app, but never the WebView bridge.
 */
internal object ProvisioningQrSession {
  private data class Callbacks(
    val success: (Security2QrCredentials) -> Unit,
    val failure: (String, String) -> Unit,
  )

  private var callbacks: Callbacks? = null
  private var activity = WeakReference<ProvisioningQrActivity>(null)

  @Synchronized
  fun begin(
    success: (Security2QrCredentials) -> Unit,
    failure: (String, String) -> Unit,
  ): Boolean {
    if (callbacks != null) return false
    callbacks = Callbacks(success, failure)
    return true
  }

  @Synchronized
  fun attach(value: ProvisioningQrActivity): Boolean {
    if (callbacks == null) return false
    activity = WeakReference(value)
    return true
  }

  fun complete(credentials: Security2QrCredentials) {
    val callback = synchronized(this) {
      val current = callbacks?.success
      callbacks = null
      activity.clear()
      current
    }
    callback?.invoke(credentials)
  }

  fun fail(code: String, message: String) {
    val callback = synchronized(this) {
      val current = callbacks?.failure
      callbacks = null
      activity.clear()
      current
    }
    callback?.invoke(code, message)
  }

  fun abandon() {
    val scanner = synchronized(this) {
      callbacks = null
      val current = activity.get()
      activity.clear()
      current
    }
    scanner?.runOnUiThread { scanner.finishSilently() }
  }
}
