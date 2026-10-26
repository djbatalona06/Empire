package com.dealerdoor.app.core

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.dealerdoor.app.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNamingStrategy
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** A non-2xx answer from the Worker. [isRuleViolation]: refused for a business rule (do-not-knock, geofence, consent). */
class ApiError(val status: Int, val code: String, serverMessage: String?, val conflictId: String?) :
    Exception(serverMessage ?: code.replace('_', ' ')) {
    val isRuleViolation: Boolean get() = status in setOf(403, 409, 422)
}

@OptIn(ExperimentalSerializationApi::class)
val AppJson = Json {
    namingStrategy = JsonNamingStrategy.SnakeCase
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}

/** Request bodies are built as plain maps, like the iOS client. */
fun Any?.toJson(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is String -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(entries.associate { (k, v) -> k.toString() to v.toJson() })
    is Iterable<*> -> JsonArray(map { it.toJson() })
    else -> JsonPrimitive(toString())
}

/** Thin JSON client for the Worker API. Refreshes the access token once on 401. */
object Api {
    val base: String = BuildConfig.API_BASE_URL.trimEnd('/')

    @PublishedApi internal val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private val jsonType = "application/json".toMediaType()
    private val _sessionExpired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val sessionExpired: SharedFlow<Unit> = _sessionExpired

    suspend inline fun <reified T> get(path: String): T = AppJson.decodeFromString(data("GET", path))

    suspend inline fun <reified T> post(path: String, body: Map<String, Any?> = emptyMap()): T =
        AppJson.decodeFromString(data("POST", path, body))

    suspend fun send(method: String, path: String, body: Map<String, Any?> = emptyMap()): String = data(method, path, body)

    suspend fun data(method: String, path: String, body: Map<String, Any?>? = null, retried: Boolean = false): String =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url("$base/v1/$path")
            TokenStore.tokens?.let { builder.header("Authorization", "Bearer ${it.accessToken}") }
            val payload = if (method == "GET") null else (body ?: emptyMap()).toJson().toString().toRequestBody(jsonType)
            builder.method(method, payload)

            val (status, text) = http.newCall(builder.build()).execute().use { it.code to it.body.string() }

            if (status == 401 && !retried && !path.startsWith("auth/")) {
                val refresh = TokenStore.tokens?.refreshToken
                if (refresh != null && refreshTokens(refresh)) return@withContext data(method, path, body, retried = true)
                if (refresh != null) {
                    TokenStore.tokens = null
                    _sessionExpired.tryEmit(Unit)
                }
            }
            if (status !in 200..299) {
                val obj = runCatching { AppJson.parseToJsonElement(text).jsonObject }.getOrNull()
                fun field(k: String) = obj?.get(k)?.jsonPrimitive?.contentOrNull
                throw ApiError(status, field("error") ?: "http_$status", field("message"), field("conflict_id"))
            }
            text
        }

    private suspend fun refreshTokens(refresh: String): Boolean =
        runCatching { post<Tokens>("auth/refresh", mapOf("refresh_token" to refresh)) }
            .onSuccess { TokenStore.tokens = it }
            .isSuccess

    /** Two-step private upload: get a signed URL, then PUT the bytes. Returns the storage key. */
    suspend fun upload(bytes: ByteArray, kind: String, contentType: String = "image/jpeg"): String {
        val ticket = post<UploadTicket>("uploads", mapOf("kind" to kind, "content_type" to contentType))
        val ok = withContext(Dispatchers.IO) {
            val req = Request.Builder().url(ticket.uploadUrl).put(bytes.toRequestBody(contentType.toMediaType())).build()
            http.newCall(req).execute().use { it.code == 201 }
        }
        if (!ok) throw ApiError(0, "upload_failed", null, null)
        return ticket.key
    }
}

/** Last-known-good copies of GET responses so the field app works without LTE. */
object OfflineCache {
    lateinit var dir: File

    suspend inline fun <reified T> get(path: String): T {
        val file = File(dir, path.replace('/', '_') + ".json")
        return try {
            val text = Api.data("GET", path)
            val value = AppJson.decodeFromString<T>(text)
            runCatching { file.writeText(text) }
            value
        } catch (e: IOException) {
            val cached = runCatching { AppJson.decodeFromString<T>(file.readText()) }.getOrNull()
            cached ?: throw e
        }
    }

    fun clear() {
        dir.listFiles { f -> f.extension == "json" }?.forEach { it.delete() }
    }
}

/** Access + refresh tokens, encrypted with a key that never leaves the Android Keystore. */
object TokenStore {
    private const val ALIAS = "dealerdoor.tokens"
    private lateinit var prefs: SharedPreferences
    private var cached: Tokens? = null
    private var loaded = false

    fun init(context: Context) {
        prefs = context.getSharedPreferences("secure", Context.MODE_PRIVATE)
    }

    var tokens: Tokens?
        @Synchronized get() {
            if (!loaded) {
                cached = prefs.getString("tokens", null)?.let { runCatching { AppJson.decodeFromString<Tokens>(decrypt(it)) }.getOrNull() }
                loaded = true
            }
            return cached
        }
        @Synchronized set(value) {
            cached = value
            loaded = true
            prefs.edit().apply {
                if (value == null) remove("tokens") else putString("tokens", encrypt(AppJson.encodeToString(Tokens.serializer(), value)))
            }.apply()
        }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(plain.toByteArray()), Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12)) }
        return String(cipher.doFinal(bytes, 12, bytes.size - 12))
    }
}
