package com.dealerdoor.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.util.UUID

/** A field capture (lead, check-in, appointment) waiting to reach the server. Photos live next to the queue file. */
@Serializable
data class PendingOp(
    val id: String = UUID.randomUUID().toString(),
    val path: String,
    val body: String,
    val label: String,
    val createdAt: Long = System.currentTimeMillis(),
    val attempts: Int = 0,
    val lastError: String? = null,
    /** Server refused it on a business rule (e.g. do-not-knock); kept for the rep to see, never retried. */
    val conflicted: Boolean = false,
    val photoFile: String? = null,
    val photoKind: String? = null,
    val signatureFile: String? = null,
)

/**
 * Every capture goes through this queue, online or not, so there is one code path.
 * Records carry a client UUID in `body["id"]`, so the API treats replays as no-ops.
 */
object SyncEngine {
    private lateinit var dir: File
    private val queueFile get() = File(dir, "queue.json")
    private val mutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _ops = MutableStateFlow<List<PendingOp>>(emptyList())
    val ops: StateFlow<List<PendingOp>> = _ops

    fun init(filesDir: File) {
        dir = File(filesDir, "sync").apply { mkdirs() }
        _ops.value = runCatching { AppJson.decodeFromString(ListSerializer(PendingOp.serializer()), queueFile.readText()) }.getOrDefault(emptyList())
    }

    fun enqueue(path: String, body: Map<String, Any?>, label: String, photo: ByteArray? = null, photoKind: String? = null, signature: ByteArray? = null) {
        val id = UUID.randomUUID().toString()
        val photoFile = photo?.let { File(dir, "$id.jpg").apply { writeBytes(it) }.name }
        val sigFile = signature?.let { File(dir, "$id.sig.png").apply { writeBytes(it) }.name }
        val op = PendingOp(id = id, path = path, body = body.toJson().toString(), label = label, photoFile = photoFile, photoKind = photoKind, signatureFile = sigFile)
        scope.launch {
            mutex.withLock { save(_ops.value + op) }
            flush()
        }
    }

    fun dismiss(op: PendingOp) {
        scope.launch { mutex.withLock { remove(op) } }
    }

    fun clear() {
        scope.launch { mutex.withLock { _ops.value.forEach(::remove) } }
    }

    /** Replays in capture order. Network/server errors stop the run; rule violations flag that item and move on. */
    suspend fun flush() {
        if (TokenStore.tokens == null || !mutex.tryLock()) return
        try {
            for (op in _ops.value.filter { !it.conflicted }) {
                var current = op
                try {
                    val body = AppJson.parseToJsonElement(current.body).jsonObject.toMutableMap()
                    current.photoFile?.let { name ->
                        body["photo_key"] = JsonPrimitive(Api.upload(File(dir, name).readBytes(), current.photoKind ?: "door_photo"))
                        File(dir, name).delete()
                        current = current.copy(photoFile = null, body = JsonObject(body).toString()).also(::replace)
                    }
                    current.signatureFile?.let { name ->
                        body["signature_key"] = JsonPrimitive(Api.upload(File(dir, name).readBytes(), "signature", "image/png"))
                        File(dir, name).delete()
                        current = current.copy(signatureFile = null, body = JsonObject(body).toString()).also(::replace)
                    }
                    Api.send("POST", current.path, body)
                    remove(current)
                } catch (e: ApiError) {
                    if (e.status in 400..499 && e.status != 401 && e.status != 429) {
                        replace(current.copy(conflicted = true, lastError = e.message))
                    } else {
                        replace(current.copy(attempts = current.attempts + 1, lastError = e.message))
                        return
                    }
                } catch (e: Exception) {
                    replace(current.copy(attempts = current.attempts + 1, lastError = e.message))
                    return
                }
            }
        } finally {
            mutex.unlock()
        }
    }

    fun flushInBackground() {
        scope.launch { flush() }
    }

    private fun replace(op: PendingOp) = save(_ops.value.map { if (it.id == op.id) op else it })

    private fun remove(op: PendingOp) {
        listOfNotNull(op.photoFile, op.signatureFile).forEach { File(dir, it).delete() }
        save(_ops.value.filterNot { it.id == op.id })
    }

    private fun save(list: List<PendingOp>) {
        _ops.value = list
        queueFile.writeText(AppJson.encodeToString(ListSerializer(PendingOp.serializer()), list))
    }
}
