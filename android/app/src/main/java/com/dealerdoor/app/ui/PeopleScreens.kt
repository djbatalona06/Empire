package com.dealerdoor.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Celebration
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.dealerdoor.app.R
import com.dealerdoor.app.core.Api
import com.dealerdoor.app.core.ApiError
import com.dealerdoor.app.core.CanvassRoute
import com.dealerdoor.app.core.Coworker
import com.dealerdoor.app.core.CrewScorecard
import com.dealerdoor.app.core.Fmt
import com.dealerdoor.app.core.OfflineCache
import com.dealerdoor.app.core.Scorecard
import com.dealerdoor.app.core.TrendPoint
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** Weekly 3-question pulse. Anonymous unless the coworker opts in to a named follow-up. */
@Composable
fun PulseDialog(onClose: () -> Unit, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var workload by remember { mutableIntStateOf(3) }
    var safety by remember { mutableIntStateOf(3) }
    var support by remember { mutableIntStateOf(3) }
    var anonymous by remember { mutableStateOf(true) }
    var followup by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false),
        modifier = Modifier.padding(16.dp),
        title = { Text(stringResource(R.string.weekly_check_in)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                ScoreScale(stringResource(R.string.pulse_q_workload), workload) { workload = it }
                ScoreScale(stringResource(R.string.pulse_q_safety), safety) { safety = it }
                ScoreScale(stringResource(R.string.pulse_q_support), support) { support = it }
                ToggleRow(stringResource(R.string.answer_anonymously), anonymous) { anonymous = it; if (it) followup = false }
                if (!anonymous) ToggleRow(stringResource(R.string.want_followup), followup) { followup = it }
                Text(stringResource(R.string.pulse_footer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                scope.launch {
                    try {
                        Api.send("POST", "pulse", mapOf("workload_score" to workload, "safety_score" to safety, "support_score" to support, "anonymous" to anonymous, "followup_requested" to followup))
                        onDone()
                    } catch (e: ApiError) {
                        if (e.code == "already_submitted_this_week") onDone() else error = e.message
                    } catch (e: Exception) {
                        error = e.message
                    }
                }
            }) { Text(stringResource(R.string.submit)) }
        },
        dismissButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.later)) } },
    )
}

private data class Scorecards(val mine: Scorecard, val crew: CrewScorecard)

@Composable
fun ScorecardScreen() {
    var giveKudos by remember { mutableStateOf(false) }
    Screen(
        stringResource(R.string.my_scorecard),
        actions = {
            IconButton(onClick = { giveKudos = true }) { Icon(Icons.Filled.Celebration, contentDescription = stringResource(R.string.give_kudos)) }
            AccountMenu()
        },
    ) {
        AsyncContent(load = {
            coroutineScope {
                val mine = async { Api.get<Scorecard>("scorecards/me") }
                val crew = async { Api.get<CrewScorecard>("scorecards/crew") }
                Scorecards(mine.await(), crew.await())
            }
        }) { data, reload ->
            Refreshable(data, reload) {
                LazyColumn(Modifier.fillMaxSize()) {
                    data.mine.sales?.let { s ->
                        item {
                            SectionHeader(stringResource(R.string.last_90_days))
                            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                                Stat(stringResource(R.string.leads), s.leads)
                                Stat(stringResource(R.string.appts), s.appointments)
                                Stat(stringResource(R.string.orders), s.orders)
                                Stat(stringResource(R.string.active), s.activations)
                            }
                        }
                    }
                    item {
                        SectionHeader(stringResource(R.string.my_trend))
                        TrendChart(data.mine.trend)
                        SectionHeader(stringResource(R.string.crew_average))
                        if (data.crew.trend.isEmpty()) {
                            Text(stringResource(R.string.crew_hidden), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
                        } else {
                            TrendChart(data.crew.trend)
                        }
                        SectionHeader(stringResource(R.string.kudos))
                        if (data.mine.kudos.isEmpty()) Text(stringResource(R.string.no_kudos), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
                    }
                    items(data.mine.kudos, key = { it.id }) { k ->
                        ListItem(headlineContent = { Text(k.message) }, supportingContent = { Text("${k.fromName ?: "—"} · ${Fmt.date(k.createdAt)}") })
                    }
                }
            }
        }
    }
    if (giveKudos) KudosDialog { giveKudos = false }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.Stat(label: String, value: Int) {
    Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("$value", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Workload / safety / support by week on a 1–5 scale. Drawn by hand to avoid a chart library. */
@Composable
fun TrendChart(points: List<TrendPoint>) {
    if (points.isEmpty()) {
        Text(stringResource(R.string.trend_empty), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
        return
    }
    val series = listOf(
        Triple(stringResource(R.string.workload), Color(0xFF0B6BCB), points.map { it.workload }),
        Triple(stringResource(R.string.safety), Color(0xFF1B873F), points.map { it.safety }),
        Triple(stringResource(R.string.support), Color(0xFFB45309), points.map { it.support }),
    )
    val grid = MaterialTheme.colorScheme.outlineVariant
    val label = stringResource(R.string.trend_a11y)
    Column(Modifier.padding(horizontal = 16.dp)) {
        Canvas(Modifier.fillMaxWidth().height(160.dp).semantics { contentDescription = label }) {
            fun y(v: Double) = size.height - ((v - 1) / 4f * size.height).toFloat()
            fun x(i: Int) = if (points.size == 1) size.width / 2 else i * size.width / (points.size - 1)
            for (v in 1..5) drawLine(grid, Offset(0f, y(v.toDouble())), Offset(size.width, y(v.toDouble())), strokeWidth = 1f)
            for ((_, color, values) in series) {
                var prev: Offset? = null
                values.forEachIndexed { i, v ->
                    if (v == null) return@forEachIndexed
                    val p = Offset(x(i), y(v))
                    prev?.let { drawLine(color, it, p, strokeWidth = 4f) }
                    drawCircle(color, radius = 6f, center = p, style = Stroke(width = 4f))
                    prev = p
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.padding(top = 6.dp)) {
            for ((name, color, _) in series) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Surface(color = color, shape = CircleShape, modifier = Modifier.size(10.dp)) {}
                    Text(name, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(start = 4.dp))
                }
            }
        }
    }
}

/** Peer kudos must point at a route or an order (spec 4.6). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KudosDialog(onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var coworkers by remember { mutableStateOf<List<Coworker>>(emptyList()) }
    var routes by remember { mutableStateOf<List<CanvassRoute>>(emptyList()) }
    var to by remember { mutableStateOf<Coworker?>(null) }
    var route by remember { mutableStateOf<CanvassRoute?>(null) }
    var orderId by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        coworkers = runCatching { Api.get<List<Coworker>>("coworkers") }.getOrDefault(emptyList())
        routes = runCatching { OfflineCache.get<List<CanvassRoute>>("routes/mine") }.getOrDefault(emptyList())
    }
    val canSend = to != null && message.isNotBlank() && message.length <= 280 && (route != null || orderId.isNotBlank())

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(stringResource(R.string.give_kudos)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Picker(stringResource(R.string.coworker), coworkers, to, { it.displayName ?: "—" }) { to = it }
                Picker(stringResource(R.string.route), routes, route, { routeLabel(it.name, it.routeDate) }) { route = it }
                OutlinedTextField(orderId, { orderId = it }, label = { Text(stringResource(R.string.or_order_id)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    message, { message = it },
                    label = { Text(stringResource(R.string.message)) },
                    minLines = 2,
                    supportingText = { Text("${message.length}/280", color = if (message.length > 280) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) },
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = canSend, onClick = {
                val target = to ?: return@TextButton
                scope.launch {
                    val body = mutableMapOf<String, Any?>("to_user_id" to target.id, "message" to message)
                    route?.let { body["route_id"] = it.id }
                    if (orderId.isNotBlank()) body["order_id"] = orderId.trim()
                    try {
                        Api.send("POST", "kudos", body)
                        onClose()
                    } catch (e: Exception) {
                        error = e.message
                    }
                }
            }) { Text(stringResource(R.string.send)) }
        },
        dismissButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.cancel)) } },
    )
}

private fun routeLabel(name: String, date: String) = "$name · $date"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> Picker(label: String, options: List<T>, selected: T?, text: (T) -> String, onPick: (T?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        OutlinedTextField(
            value = selected?.let(text) ?: stringResource(R.string.choose),
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.none)) }, onClick = { onPick(null); open = false })
            options.forEach { option -> DropdownMenuItem(text = { Text(text(option)) }, onClick = { onPick(option); open = false }) }
        }
    }
}
