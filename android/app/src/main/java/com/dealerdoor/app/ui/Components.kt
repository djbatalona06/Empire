package com.dealerdoor.app.ui

import android.graphics.Bitmap
import android.graphics.Canvas as AndroidCanvas
import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.dealerdoor.app.R
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

// ---- Theme ----

val Brand = Color(0xFF0B6BCB)

@Composable
fun DealerDoorTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFF8CC2FF)) else lightColorScheme(primary = Brand)
    MaterialTheme(colorScheme = colors) { Surface(Modifier.fillMaxSize(), content = content) }
}

// ---- Loading ----

/** Loads data with loading / error / retry states. `content` gets the value and a reload function. */
@Composable
fun <T> AsyncContent(key: Any? = Unit, load: suspend () -> T, content: @Composable (T, suspend () -> Unit) -> Unit) {
    var value by remember(key) { mutableStateOf<T?>(null) }
    var error by remember(key) { mutableStateOf<String?>(null) }
    val reload: suspend () -> Unit = {
        try {
            value = load()
            error = null
        } catch (e: Exception) {
            if (value == null) error = e.message ?: e.toString()
        }
    }
    LaunchedEffect(key) { reload() }
    val scope = rememberCoroutineScope()
    val current = value
    when {
        current != null -> content(current, reload)
        error != null -> Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Filled.WifiOff, contentDescription = null, modifier = Modifier.size(40.dp))
            Text(stringResource(R.string.couldnt_load), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
            Text(error.orEmpty(), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = { scope.launch { reload() } }, modifier = Modifier.padding(top = 12.dp)) { Text(stringResource(R.string.try_again)) }
        }
        else -> Loading()
    }
}

@Composable
fun Loading() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }

@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(body, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
    }
}

// ---- Rows ----

@Composable
fun SectionHeader(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp),
    )
}

@Composable
fun LabeledRow(label: String, value: String, bold: Boolean = false) {
    ListItem(
        headlineContent = { Text(label) },
        trailingContent = { Text(value, fontWeight = if (bold) FontWeight.Bold else null) },
    )
}

// ---- Status badge ----

@Composable
fun statusLabel(status: String): String {
    val res = when (status) {
        "submitted" -> R.string.status_submitted
        "scheduled" -> R.string.status_scheduled
        "installed" -> R.string.status_installed
        "activated" -> R.string.status_activated
        "closed" -> R.string.status_closed
        "cancelled" -> R.string.status_cancelled
        "draft" -> R.string.status_draft
        "sent" -> R.string.status_sent
        "viewed" -> R.string.status_viewed
        "partial" -> R.string.status_partial
        "paid" -> R.string.status_paid
        "overdue" -> R.string.status_overdue
        "pending" -> R.string.status_pending
        "approved" -> R.string.status_approved
        "rejected" -> R.string.status_rejected
        "complete" -> R.string.status_complete
        "in_progress" -> R.string.status_in_progress
        "delayed" -> R.string.status_delayed
        "new" -> R.string.status_new
        "interested" -> R.string.status_interested
        "appointment" -> R.string.status_appointment
        "order" -> R.string.status_order
        "not_serviceable" -> R.string.status_not_serviceable
        "succeeded" -> R.string.status_succeeded
        "failed" -> R.string.status_failed
        else -> null
    }
    return res?.let { stringResource(it) } ?: status.replace('_', ' ')
}

@Composable
fun StatusBadge(status: String) {
    val color = when (status) {
        "paid", "complete", "activated", "approved" -> Color(0xFF1B873F)
        "overdue", "rejected", "cancelled", "not_serviceable" -> Color(0xFFC62828)
        "partial", "delayed", "pending" -> Color(0xFFB45309)
        else -> Brand
    }
    Text(
        statusLabel(status),
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
        color = color,
        modifier = Modifier.background(color.copy(alpha = 0.14f), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
fun BillingNotice(text: String, modifier: Modifier = Modifier) {
    Row(modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.Filled.Info, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ---- Inputs ----

@Composable
fun StarRating(title: String, value: Int, onChange: (Int) -> Unit) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text(title)
        Row {
            for (i in 1..5) {
                val desc = stringResource(R.string.n_stars, i)
                IconButton(onClick = { onChange(i) }, modifier = Modifier.semantics { contentDescription = desc }) {
                    Icon(if (i <= value) Icons.Filled.Star else Icons.Filled.StarBorder, contentDescription = null, tint = Color(0xFFF5B400))
                }
            }
        }
    }
}

/** 1–5 picker used by the weekly pulse. */
@Composable
fun ScoreScale(title: String, value: Int, onChange: (Int) -> Unit) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(title)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            for (i in 1..5) {
                SegmentedButton(selected = value == i, onClick = { onChange(i) }, shape = SegmentedButtonDefaults.itemShape(i - 1, 5)) { Text("$i") }
            }
        }
        Row(Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.poor), style = MaterialTheme.typography.labelSmall)
            Spacer(Modifier.weight(1f))
            Text(stringResource(R.string.great), style = MaterialTheme.typography.labelSmall)
        }
    }
}

/** Finger signature, exported as PNG for the consent record. */
@Composable
fun SignaturePad(onChange: (ByteArray?) -> Unit) {
    val lines = remember { mutableStateListOf<List<Offset>>() }
    var current by remember { mutableStateOf<List<Offset>>(emptyList()) }
    val ink = MaterialTheme.colorScheme.onSurface
    val label = stringResource(R.string.signature_area)

    fun export(widthPx: Int, heightPx: Int) {
        if (lines.isEmpty()) return onChange(null)
        val bmp = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
        val c = AndroidCanvas(bmp).apply { drawColor(android.graphics.Color.WHITE) }
        val paint = Paint().apply { color = android.graphics.Color.BLACK; strokeWidth = 5f; style = Paint.Style.STROKE; isAntiAlias = true; strokeCap = Paint.Cap.ROUND }
        for (line in lines) for (i in 1 until line.size) c.drawLine(line[i - 1].x, line[i - 1].y, line[i].x, line[i].y, paint)
        onChange(ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray())
    }

    Column(Modifier.padding(horizontal = 16.dp)) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(140.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp))
                .semantics { contentDescription = label }
                .pointerInput(Unit) {
                    detectDragGestures(
                        onDragStart = { current = listOf(it) },
                        onDrag = { change, _ -> current = current + change.position },
                        onDragEnd = {
                            lines.add(current)
                            current = emptyList()
                            export(this.size.width, this.size.height)
                        },
                    )
                },
        ) {
            for (line in lines + listOf(current)) {
                if (line.size < 2) continue
                val path = Path().apply { moveTo(line[0].x, line[0].y); line.drop(1).forEach { lineTo(it.x, it.y) } }
                drawPath(path, ink, style = Stroke(width = 5f, cap = StrokeCap.Round))
            }
        }
        TextButton(onClick = { lines.clear(); onChange(null) }, modifier = Modifier.align(Alignment.End)) { Text(stringResource(R.string.clear)) }
    }
}

/** Selectable row used for check-box style choices. */
fun Modifier.choice(selected: Boolean, onClick: () -> Unit) = selectable(selected = selected, role = Role.Checkbox, onClick = onClick)

@Composable
fun Gap(h: Int = 8) = Spacer(Modifier.height(h.dp).width(1.dp))
