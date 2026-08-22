package com.pingpong.voice

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.provider.MediaStore
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermissionRequest: PermissionRequest? = null
    private var popupWebView: WebView? = null
    private var popupDialog: AlertDialog? = null
    private var pendingCameraPhotoUri: Uri? = null

    private val webAppUri: Uri by lazy { Uri.parse(BuildConfig.WEB_APP_URL) }
    private val approvedHost: String by lazy { webAppUri.host?.lowercase(Locale.US).orEmpty() }

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        val cameraUri = pendingCameraPhotoUri
        pendingCameraPhotoUri = null
        if (callback == null) return@registerForActivityResult
        val uris = if (result.resultCode == RESULT_OK) {
            val data = result.data
            when {
                data?.clipData != null -> Array(data.clipData!!.itemCount) { i -> data.clipData!!.getItemAt(i).uri }
                data?.data != null -> arrayOf(data.data!!)
                // ACTION_IMAGE_CAPTURE writes the photo straight to EXTRA_OUTPUT and
                // returns no data Uri of its own — this is the camera-capture branch.
                cameraUri != null -> arrayOf(cameraUri)
                else -> emptyArray()
            }
        } else {
            emptyArray()
        }
        callback.onReceiveValue(uris)
    }

    private val mediaPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val request = pendingPermissionRequest
        pendingPermissionRequest = null
        if (request == null) return@registerForActivityResult

        val requestedResources = request.resources.toList()
        val requestedPermissions = requestedResources.flatMap { resourceToPermissions(it) }.distinct()
        val audioGranted = !requestedResources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) ||
            hasPermission(Manifest.permission.RECORD_AUDIO)
        val videoGranted = !requestedResources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) ||
            hasPermission(Manifest.permission.CAMERA)

        if (audioGranted && videoGranted) {
            request.grant(request.resources)
        } else {
            request.deny()
            val permanentlyDenied = requestedPermissions.filter {
                !hasPermission(it) && !shouldShowRequestPermissionRationale(it)
            }
            if (permanentlyDenied.isNotEmpty()) {
                showSettingsDialog(
                    title = "Permission required",
                    message = "Camera and microphone access were permanently denied. Open Android settings to enable them for Ping Pong voice rooms and calls."
                )
            } else {
                Toast.makeText(
                    this,
                    "Camera and microphone permission is required for calls and voice chat.",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    // Proactively ask for the permissions needed by Ping Pong voice/video rooms.
    // Android still requires the user to explicitly approve each runtime permission;
    // this launcher simply makes the permission dialog appear automatically on first run.
    private val startupPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val denied = grants.filterValues { !it }.keys
        if (denied.isNotEmpty()) {
            Toast.makeText(
                this,
                "Microphone/camera access is needed for Ping Pong voice rooms. You can enable it in Android settings anytime.",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (!granted && android.os.Build.VERSION.SDK_INT >= 33) {
            val permanentlyDenied = !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
            if (permanentlyDenied) {
                showSettingsDialog(
                    title = "Notification permission disabled",
                    message = "Notifications are disabled. You can enable them later in Android settings if you want download or background voice notifications."
                )
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web_view)
        configureWebView(webView, isMainView = true)

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(BuildConfig.WEB_APP_URL)
        }

        requestStartupPermissionsIfNeeded()
        requestNotificationPermissionIfNeeded()
        configureBackNavigation()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(view: WebView, isMainView: Boolean) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val settings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = true
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.setSupportMultipleWindows(true)
        settings.mediaPlaybackRequiresUserGesture = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.loadsImagesAutomatically = true
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.setSupportZoom(false)
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            settings.safeBrowsingEnabled = true
        }
        settings.userAgentString = settings.userAgentString + " PingPongAndroid/" + BuildConfig.VERSION_NAME

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, true)
            flush()
        }

        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.overScrollMode = WebView.OVER_SCROLL_NEVER

        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                return handleUrlNavigation(request.url)
            }

            @Deprecated("Deprecated in API 24")
            override fun shouldOverrideUrlLoading(v: WebView, url: String): Boolean =
                handleUrlNavigation(Uri.parse(url))

            override fun onPageStarted(v: WebView, url: String, favicon: Bitmap?) {
                super.onPageStarted(v, url, favicon)
                if (isMainView && !isAllowedTopLevelNavigation(Uri.parse(url))) {
                    v.stopLoading()
                    handleUrlNavigation(Uri.parse(url))
                }
            }

            override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                super.onReceivedError(v, request, error)
                if (request.isForMainFrame) {
                    Toast.makeText(
                        this@MainActivity,
                        "Network error. Please check your connection.",
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                Toast.makeText(
                    this@MainActivity,
                    "Secure connection failed. Please try again later.",
                    Toast.LENGTH_LONG
                ).show()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                view.destroy()
                setContentView(R.layout.activity_main)
                webView = findViewById(R.id.web_view)
                configureWebView(webView, isMainView = true)
                webView.loadUrl(BuildConfig.WEB_APP_URL)
                Toast.makeText(
                    this@MainActivity,
                    "The web content was restarted after an unexpected crash.",
                    Toast.LENGTH_LONG
                ).show()
                return true
            }
        }

        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handleWebPermissionRequest(request) }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingPermissionRequest == request) {
                    pendingPermissionRequest = null
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                pendingCameraPhotoUri = null
                return try {
                    val pickerIntent = fileChooserParams.createIntent().apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                    }
                    // FIX (2026-08-14 Android production audit): the file_paths.xml
                    // FileProvider config already existed in the project's resources but
                    // was never wired to an actual capture flow (no <provider> in the
                    // manifest, no code using it — see AndroidManifest.xml's fix comment).
                    // Only offer "take a photo" when the <input> actually accepts images
                    // (fileChooserParams.acceptTypes reflects the accept="..." attribute)
                    // AND the camera permission is already granted — if it isn't, silently
                    // omitting the camera option here is preferable to launching a capture
                    // intent that's just going to fail; the user can still pick an existing
                    // photo, and the WebView's own getUserMedia() permission flow (a
                    // completely separate path, see handleWebPermissionRequest) is what
                    // actually prompts for CAMERA when the web app needs live video.
                    val acceptsImages = fileChooserParams.acceptTypes.isNullOrEmpty() ||
                        fileChooserParams.acceptTypes.any { it.isBlank() || it.contains("image", ignoreCase = true) }
                    val extraIntents = if (acceptsImages && hasPermission(Manifest.permission.CAMERA)) {
                        createCameraCaptureIntent()?.let { arrayOf<Intent>(it) } ?: emptyArray()
                    } else {
                        emptyArray()
                    }
                    val chooser = Intent.createChooser(pickerIntent, "Select or capture a file").apply {
                        if (extraIntents.isNotEmpty()) putExtra(Intent.EXTRA_INITIAL_INTENTS, extraIntents)
                    }
                    filePicker.launch(chooser)
                    true
                } catch (_: ActivityNotFoundException) {
                    fileChooserCallback = null
                    pendingCameraPhotoUri = null
                    Toast.makeText(this@MainActivity, "No file picker is available.", Toast.LENGTH_SHORT).show()
                    false
                }
            }

            override fun onCreateWindow(
                parent: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message
            ): Boolean {
                if (!isUserGesture) return false
                return openPopup(resultMsg)
            }

            override fun onCloseWindow(window: WebView) {
                closePopup()
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                callback.invoke(origin, false, false)
            }
        }

        view.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            downloadFile(url, userAgent, contentDisposition, mimeType)
        })

        if (isMainView) {
            view.addJavascriptInterface(WebAppInterface(this), "AndroidVoiceBridge")
        }
    }

    private inner class WebAppInterface(private val activity: MainActivity) {
        // SECURITY FIX (2026-08-14 Android production audit): addJavascriptInterface()
        // exposes this bridge to the WHOLE WebView instance, not just the trusted
        // PingPong page — any page this WebView is allowed to top-level-navigate to
        // (accounts.google.com during Firebase auth, youtube.com, the jsdelivr/esm.sh/
        // unpkg CDN hosts, wa.me) would otherwise also be able to call
        // window.AndroidVoiceBridge.onVoiceSessionStart()/onVoiceSessionEnd() and
        // silently start/stop the foreground voice service. addJavascriptInterface has
        // no built-in per-origin restriction, so every method here re-checks the
        // WebView's CURRENT origin before doing anything — only the approved PingPong
        // host is ever allowed to actually trigger these actions. WebView.getUrl() is
        // only safe to call from the UI thread (JS bridge methods run on a background
        // thread by default), so the check happens INSIDE runOnUiThread, not before it.
        @android.webkit.JavascriptInterface
        fun onVoiceSessionStart() {
            runOnUiThread {
                val currentHost = Uri.parse(activity.webView.url ?: return@runOnUiThread).host?.lowercase(Locale.US)
                if (currentHost != activity.approvedHost) return@runOnUiThread
                val intent = Intent(activity, VoiceForegroundService::class.java)
                ContextCompat.startForegroundService(activity, intent)
            }
        }

        @android.webkit.JavascriptInterface
        fun onVoiceSessionEnd() {
            runOnUiThread {
                val currentHost = Uri.parse(activity.webView.url ?: return@runOnUiThread).host?.lowercase(Locale.US)
                if (currentHost != activity.approvedHost) return@runOnUiThread
                activity.stopService(Intent(activity, VoiceForegroundService::class.java))
            }
        }
    }

    private fun openPopup(resultMsg: android.os.Message): Boolean {
        closePopup()
        val popup = WebView(this)
        popupWebView = popup
        configureWebView(popup, isMainView = false)
        popup.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                return handleUrlNavigation(request.url)
            }

            @Deprecated("Deprecated in API 24")
            override fun shouldOverrideUrlLoading(v: WebView, url: String): Boolean =
                handleUrlNavigation(Uri.parse(url))
        }

        popupDialog = AlertDialog.Builder(this)
            .setView(popup)
            .setOnDismissListener {
                popupDialog = null
                popupWebView = null
            }
            .create()
        popupDialog?.show()

        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        transport.webView = popup
        resultMsg.sendToTarget()
        return true
    }

    private fun createCameraCaptureIntent(): Intent? {
        return try {
            val fileName = "PingPong_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}.jpg"
            val photoFile = File(cacheDir, fileName)
            val photoUri = FileProvider.getUriForFile(
                this,
                "${packageName}.fileprovider",
                photoFile
            )
            pendingCameraPhotoUri = photoUri
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, photoUri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
        } catch (_: Exception) {
            pendingCameraPhotoUri = null
            null
        }
    }

    private fun closePopup() {
        val popup = popupWebView
        popupWebView = null
        popupDialog?.setOnDismissListener(null)
        popupDialog?.dismiss()
        popupDialog = null
        popup?.apply {
            stopLoading()
            loadUrl("about:blank")
            destroy()
        }
    }

    private fun handleUrlNavigation(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase(Locale.US) ?: return true
        return when (scheme) {
            "http", "https" -> {
                if (isAllowedTopLevelNavigation(uri)) {
                    false
                } else {
                    openExternal(uri)
                    true
                }
            }
            "intent" -> {
                try {
                    val intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
                    startActivity(intent)
                } catch (_: Exception) {
                    Toast.makeText(this, "No app can handle this link.", Toast.LENGTH_SHORT).show()
                }
                true
            }
            else -> {
                openExternal(uri)
                true
            }
        }
    }

    private fun isAllowedTopLevelNavigation(uri: Uri): Boolean {
        val host = uri.host?.lowercase(Locale.US) ?: return false
        val scheme = uri.scheme?.lowercase(Locale.US) ?: return false
        val isApprovedHost = host == approvedHost
        if (isApprovedHost) {
            return scheme == "https" || (BuildConfig.ALLOW_CLEARTEXT && scheme == "http")
        }
        if (scheme != "https") return false
        return authAndSupportHosts.any { host == it || host.endsWith(".$it") }
    }

    private fun isTrustedPermissionOrigin(origin: Uri?): Boolean {
        val host = origin?.host?.lowercase(Locale.US) ?: return false
        return host == approvedHost
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "No app can handle this link.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleWebPermissionRequest(request: PermissionRequest) {
        if (!isTrustedPermissionOrigin(request.origin)) {
            request.deny()
            return
        }

        val permissions = request.resources
            .flatMap { resourceToPermissions(it) }
            .distinct()
            .filterNot(::hasPermission)

        if (permissions.isEmpty()) {
            request.grant(request.resources)
        } else {
            pendingPermissionRequest = request
            mediaPermissionLauncher.launch(permissions.toTypedArray())
        }
    }

    private fun resourceToPermissions(resource: String): List<String> = when (resource) {
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        else -> emptyList()
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun downloadFile(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        if (url.startsWith("data:", ignoreCase = true)) {
            Toast.makeText(this, "This file cannot be downloaded directly by Android.", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setMimeType(mimeType ?: "application/octet-stream")
                addRequestHeader("User-Agent", userAgent)
                CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
                setTitle(fileName)
                setDescription("Downloading from Ping Pong")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setAllowedOverMetered(true)
                setAllowedOverRoaming(true)
                setDestinationInExternalFilesDir(this@MainActivity, Environment.DIRECTORY_DOWNLOADS, fileName)
            }
            val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            manager.enqueue(request)
            Toast.makeText(this, "Download started.", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Download failed: ${e.message ?: "unknown error"}", Toast.LENGTH_LONG).show()
        }
    }

    private fun requestStartupPermissionsIfNeeded() {
        val permissions = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA
        )
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            permissions += Manifest.permission.BLUETOOTH_CONNECT
            permissions += Manifest.permission.BLUETOOTH_SCAN
        }
        val missing = permissions.filterNot(::hasPermission)
        if (missing.isNotEmpty()) {
            startupPermissionLauncher.launch(missing.toTypedArray())
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun showSettingsDialog(title: String, message: String) {
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setNegativeButton("Not now", null)
            .setPositiveButton("Open settings") { _, _ -> openAppSettings() }
            .show()
    }

    private fun openAppSettings() {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", packageName, null)
        )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
    }

    private fun configureBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    popupDialog?.isShowing == true -> closePopup()
                    webView.canGoBack() -> webView.goBack()
                    else -> moveTaskToBack(true)
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        webView.onPause()
        webView.pauseTimers()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        // BUG FIX (2026-08-14 Android production audit): this used to call stopService()
        // UNCONDITIONALLY on every onDestroy(). onDestroy() does NOT only fire when the
        // user actually leaves the app — it also fires when the Activity is destroyed and
        // recreated for a configuration change the manifest's android:configChanges list
        // doesn't cover (e.g. entering split-screen/multi-window, some OEM-specific
        // transitions), and potentially during low-memory Activity recreation. In every
        // one of those cases isFinishing is false — the Activity is coming right back via
        // onCreate() — but the old code would tear down the live voice foreground service
        // (and the WebRTC/SFU voice session riding on top of it) anyway, exactly the
        // "temporary Activity lifecycle changes must not unnecessarily stop an active
        // voice session" failure this audit was asked to fix. Gate both the service
        // teardown and the WebView teardown on isFinishing, so only a genuine app-exit
        // (back button at root, task swiped away and system finishes the Activity, user
        // explicitly closing) stops the voice session — a config-change recreate now
        // leaves it running exactly like it already correctly does for the WebView state.
        if (isFinishing) {
            stopService(Intent(this, VoiceForegroundService::class.java))
        }
        closePopup()
        if (isFinishing) {
            webView.apply {
                stopLoading()
                webChromeClient = null
                webViewClient = WebViewClient()
                destroy()
            }
        }
        super.onDestroy()
    }

    companion object {
        private val authAndSupportHosts = setOf(
            "accounts.google.com",
            "apis.google.com",
            "www.googleapis.com",
            "www.gstatic.com",
            "fonts.googleapis.com",
            "fonts.gstatic.com",
            "ping-pong-voice-chat-24a27.firebaseapp.com",
            "cdn.jsdelivr.net",
            "esm.sh",
            "unpkg.com",
            "www.youtube.com",
            "m.youtube.com",
            "youtu.be",
            "wa.me"
        )
    }
}
