package com.openiot.moodlight.provisioning

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private const val CAMERA_PERMISSION_REQUEST = 4107
private const val MAX_QR_BYTES = 1_024
private val REQUIRED_FIELDS = setOf("transport", "security", "name", "username", "password")
private val PRODUCT_FIELDS = REQUIRED_FIELDS + setOf("serial", "registrationCode")
private val SAFE_NAME = Regex("^[A-Za-z0-9_-]{1,64}$")
private val SAFE_USERNAME = Regex("^[A-Za-z0-9_-]{1,128}$")
private val SAFE_PASSWORD = Regex("^[A-Za-z0-9_-]{16,256}$")
private val SAFE_SERIAL = Regex("^[A-Za-z0-9_-]{1,128}$")
private val SAFE_REGISTRATION_CODE = Regex("^[A-Za-z0-9_-]{16,512}$")

class ProvisioningQrActivity : AppCompatActivity() {
  private val completed = AtomicBoolean(false)
  private val processing = AtomicBoolean(false)
  private lateinit var previewView: PreviewView
  private lateinit var cameraExecutor: ExecutorService
  private var cameraProvider: ProcessCameraProvider? = null
  private var scanner: BarcodeScanner? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    if (!ProvisioningQrSession.attach(this)) {
      completed.set(true)
      finish()
      return
    }

    previewView = PreviewView(this).apply {
      implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    }
    val root = FrameLayout(this).apply {
      setBackgroundColor(Color.BLACK)
      addView(previewView, FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ))
      addView(TextView(this@ProvisioningQrActivity).apply {
        text = "기기에 부착된 등록 QR을 화면 안에 맞춰 주세요."
        setTextColor(Color.WHITE)
        textSize = 17f
        gravity = Gravity.CENTER
        setBackgroundColor(0x99000000.toInt())
        setPadding(32, 24, 32, 24)
      }, FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.TOP,
      ))
      addView(Button(this@ProvisioningQrActivity).apply {
        text = "취소"
        setOnClickListener { cancelScan() }
      }, FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
      ).apply { bottomMargin = 64 })
    }
    setContentView(root)

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = cancelScan()
    })

    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      startCamera()
    } else {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST)
    }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != CAMERA_PERMISSION_REQUEST) return
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
    else fail("CAMERA_PERMISSION_REQUIRED", "QR을 읽으려면 카메라 권한이 필요합니다.")
  }

  private fun startCamera() {
    cameraExecutor = Executors.newSingleThreadExecutor()
    scanner = BarcodeScanning.getClient(
      BarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .build(),
    )
    val providerFuture = ProcessCameraProvider.getInstance(this)
    providerFuture.addListener({
      if (completed.get()) return@addListener
      try {
        val provider = providerFuture.get()
        cameraProvider = provider
        val preview = Preview.Builder().build().also {
          it.surfaceProvider = previewView.surfaceProvider
        }
        val analysis = ImageAnalysis.Builder()
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .build()
          .also { it.setAnalyzer(cameraExecutor, ::analyze) }
        provider.unbindAll()
        provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
      } catch (_: Exception) {
        fail("CAMERA_UNAVAILABLE", "QR 카메라를 시작하지 못했습니다.")
      }
    }, ContextCompat.getMainExecutor(this))
  }

  @androidx.annotation.OptIn(ExperimentalGetImage::class)
  private fun analyze(imageProxy: ImageProxy) {
    if (completed.get() || !processing.compareAndSet(false, true)) {
      imageProxy.close()
      return
    }
    val mediaImage = imageProxy.image
    if (mediaImage == null) {
      processing.set(false)
      imageProxy.close()
      return
    }
    val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
    scanner?.process(image)
      ?.addOnSuccessListener { barcodes ->
        val raw = barcodes.firstNotNullOfOrNull { it.rawValue }
        if (raw != null && completed.compareAndSet(false, true)) {
          try {
            val credentials = parseSecurity2Qr(raw)
            stopCamera()
            ProvisioningQrSession.complete(credentials)
            finish()
          } catch (_: Exception) {
            completed.set(false)
            fail("QR_INVALID", "이 기기에 사용할 수 있는 등록 QR이 아닙니다.")
          }
        }
      }
      ?.addOnFailureListener {
        fail("QR_SCAN_FAILED", "QR을 읽지 못했습니다.")
      }
      ?.addOnCompleteListener {
        processing.set(false)
        imageProxy.close()
      }
      ?: run {
        processing.set(false)
        imageProxy.close()
      }
  }

  private fun parseSecurity2Qr(raw: String): Security2QrCredentials {
    if (raw.toByteArray(StandardCharsets.UTF_8).size > MAX_QR_BYTES) throw IllegalArgumentException()
    val json = JSONObject(raw)
    val fields = mutableSetOf<String>()
    val keys = json.keys()
    while (keys.hasNext()) fields += keys.next()
    if (fields != REQUIRED_FIELDS && fields != PRODUCT_FIELDS) throw IllegalArgumentException()
    if (json.get("transport") != "ble") throw IllegalArgumentException()
    val security = json.get("security")
    if (security !is Number || security.toDouble() != 2.0) throw IllegalArgumentException()
    val name = json.get("name") as? String ?: throw IllegalArgumentException()
    val username = json.get("username") as? String ?: throw IllegalArgumentException()
    val password = json.get("password") as? String ?: throw IllegalArgumentException()
    if (!SAFE_NAME.matches(name) || !SAFE_USERNAME.matches(username) || !SAFE_PASSWORD.matches(password)) {
      throw IllegalArgumentException()
    }
    val productRegistration = if (fields == PRODUCT_FIELDS) {
      val serial = json.get("serial") as? String ?: throw IllegalArgumentException()
      val registrationCode = json.get("registrationCode") as? String ?: throw IllegalArgumentException()
      if (!SAFE_SERIAL.matches(serial) || !SAFE_REGISTRATION_CODE.matches(registrationCode)) throw IllegalArgumentException()
      ProductRegistration(serial, registrationCode)
    } else null
    return Security2QrCredentials(name, username, password, productRegistration)
  }

  private fun cancelScan() = fail("QR_CANCELLED", "QR 읽기를 취소했습니다.")

  private fun fail(code: String, message: String) {
    if (!completed.compareAndSet(false, true)) return
    stopCamera()
    ProvisioningQrSession.fail(code, message)
    finish()
  }

  internal fun finishSilently() {
    completed.set(true)
    stopCamera()
    finish()
  }

  private fun stopCamera() {
    cameraProvider?.unbindAll()
    cameraProvider = null
    scanner?.close()
    scanner = null
    if (::cameraExecutor.isInitialized) cameraExecutor.shutdownNow()
  }

  override fun onDestroy() {
    stopCamera()
    if (!completed.get()) ProvisioningQrSession.fail("QR_CANCELLED", "QR 읽기가 종료되었습니다.")
    super.onDestroy()
  }
}
