package com.dealerdoor.app.core

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** UI tests start the app with this extra: begin signed out, with a clean offline cache. Debug builds only. */
object UiTest {
    const val EXTRA = "uitest"
}

// ---- Auth ----

sealed interface AuthState {
    data object Loading : AuthState
    data object SignedOut : AuthState
    data object Locked : AuthState
    data class SignedIn(val me: Me) : AuthState
}

object Auth {
    private val _state = MutableStateFlow<AuthState>(AuthState.Loading)
    val state: StateFlow<AuthState> = _state
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun init() {
        // Returning users unlock with fingerprint / face / screen lock instead of a new magic link.
        _state.value = if (TokenStore.tokens == null) AuthState.SignedOut else AuthState.Locked
        scope.launch { Api.sessionExpired.collect { _state.value = AuthState.SignedOut } }
    }

    fun resetForUiTest() {
        TokenStore.tokens = null
        OfflineCache.clear()
        SyncEngine.clear()
        _state.value = AuthState.SignedOut
    }

    /** Password login returns tokens; otherwise the server emails a link (debug builds get the token back). */
    suspend fun login(email: String, password: String?): Boolean {
        val body = buildMap<String, Any?> {
            put("email", email)
            if (!password.isNullOrEmpty()) put("password", password)
        }
        val res = Api.post<LoginResponse>("auth/login", body)
        if (res.accessToken != null && res.refreshToken != null) return finish(Tokens(res.accessToken, res.refreshToken))
        if (com.dealerdoor.app.BuildConfig.DEBUG && res.devToken != null) return verify(res.devToken)
        return false
    }

    suspend fun verify(token: String): Boolean = finish(Api.post("auth/verify", mapOf("token" to token)))

    /** Handles dealerdoor://auth?token=… from the sign-in email. */
    fun handle(uri: Uri) {
        val token = uri.getQueryParameter("token") ?: return
        scope.launch { runCatching { verify(token) } }
    }

    private suspend fun finish(tokens: Tokens): Boolean {
        TokenStore.tokens = tokens
        loadMe()
        return true
    }

    suspend fun loadMe() {
        val me = Api.get<Me>("me")
        _state.value = AuthState.SignedIn(me)
        // Keep server-side email language in sync with the phone.
        if (me.locale != Lang.code) runCatching { Api.send("PATCH", "me", mapOf("locale" to Lang.code)) }
    }

    fun unlocked() {
        scope.launch { runCatching { loadMe() }.onFailure { _state.value = AuthState.SignedOut } }
    }

    fun signOut() {
        scope.launch {
            TokenStore.tokens?.refreshToken?.let { refresh -> runCatching { Api.send("POST", "auth/logout", mapOf("refresh_token" to refresh)) } }
            TokenStore.tokens = null
            OfflineCache.clear()
            _state.value = AuthState.SignedOut
        }
    }
}

// ---- Connectivity & location ----

object NetworkMonitor {
    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online

    fun start(context: Context) {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        _online.value = cm.activeNetwork != null
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val cameBack = !_online.value
                _online.value = true
                if (cameBack) SyncEngine.flushInBackground()
            }

            override fun onLost(network: Network) {
                _online.value = false
            }
        })
    }
}

object LocationTracker {
    private val _location = MutableStateFlow<Location?>(null)
    val location: StateFlow<Location?> = _location
    private var started = false

    fun hasPermission(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    fun start(context: Context) {
        if (started || !hasPermission(context)) return
        started = true
        val lm = context.getSystemService(LocationManager::class.java)
        val listener = LocationListener { _location.value = it }
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (lm.isProviderEnabled(provider)) {
                lm.getLastKnownLocation(provider)?.let { if (_location.value == null) _location.value = it }
                lm.requestLocationUpdates(provider, 5_000L, 5f, listener, Looper.getMainLooper())
            }
        }
    }

    /** Street address for the rep's current spot (on-device geocoder, no API key). */
    suspend fun currentAddress(context: Context): String? {
        val loc = _location.value ?: return null
        return withContext(Dispatchers.IO) {
            @Suppress("DEPRECATION")
            val a = runCatching { Geocoder(context, Locale.US).getFromLocation(loc.latitude, loc.longitude, 1)?.firstOrNull() }.getOrNull()
                ?: return@withContext null
            listOfNotNull(
                listOfNotNull(a.subThoroughfare, a.thoroughfare).joinToString(" ").ifBlank { null },
                a.locality,
                listOfNotNull(a.adminArea?.let(::stateCode), a.postalCode).joinToString(" ").ifBlank { null },
            ).joinToString(", ")
        }
    }

    private fun stateCode(name: String) = if (name.equals("Washington", ignoreCase = true)) "WA" else name
}

// ---- Formatting & images ----

object Fmt {
    fun money(cents: Int): String = NumberFormat.getCurrencyInstance(Locale.US).format(cents / 100.0)

    private fun parse(s: String): Instant? =
        runCatching { OffsetDateTime.parse(s).toInstant() }.getOrNull()
            ?: runCatching { LocalDateTime.parse(s.replace(' ', 'T')).toInstant(ZoneOffset.UTC) }.getOrNull()

    /** Accepts ISO-8601 and SQLite "YYYY-MM-DD HH:MM:SS" (UTC). */
    fun date(s: String?, time: Boolean = false): String {
        if (s == null) return "—"
        val instant = parse(s) ?: return s
        val f = if (time) DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT) else DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
        return f.withLocale(Locale.getDefault()).format(instant.atZone(ZoneId.systemDefault()))
    }

    /** Due dates are plain YYYY-MM-DD in Pacific time. */
    fun day(s: String): String =
        runCatching { DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(Locale.getDefault()).format(LocalDate.parse(s)) }.getOrDefault(s)

    fun iso(instant: Instant): String = DateTimeFormatter.ISO_INSTANT.format(instant)
}

object ImageTools {
    /** Downscale to keep uploads small on LTE. */
    fun jpeg(context: Context, uri: Uri, maxSide: Int = 1600): ByteArray? = runCatching {
        val bitmap = context.contentResolver.openInputStream(uri)?.use(BitmapFactory::decodeStream) ?: return null
        val scale = minOf(1f, maxSide.toFloat() / maxOf(bitmap.width, bitmap.height))
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true) else bitmap
        ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.JPEG, 70, it) }.toByteArray()
    }.getOrNull()
}
