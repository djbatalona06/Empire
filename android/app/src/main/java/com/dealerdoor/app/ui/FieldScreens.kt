package com.dealerdoor.app.ui

import android.Manifest
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.LocationOff
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.ThumbDown
import androidx.compose.material.icons.filled.Update
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.dealerdoor.app.R
import com.dealerdoor.app.core.Api
import com.dealerdoor.app.core.CanvassRoute
import com.dealerdoor.app.core.CatalogItem
import com.dealerdoor.app.core.ConsentTexts
import com.dealerdoor.app.core.DnkPoint
import com.dealerdoor.app.core.Fmt
import com.dealerdoor.app.core.ImageTools
import com.dealerdoor.app.core.Lang
import com.dealerdoor.app.core.LeadDetail
import com.dealerdoor.app.core.LeadSummary
import com.dealerdoor.app.core.LocationTracker
import com.dealerdoor.app.core.NetworkMonitor
import com.dealerdoor.app.core.OfflineCache
import com.dealerdoor.app.core.PropertyCheck
import com.dealerdoor.app.core.PulseStatus
import com.dealerdoor.app.core.RouteStop
import com.dealerdoor.app.core.ServiceArea
import com.dealerdoor.app.core.Serviceability
import com.dealerdoor.app.core.SyncEngine
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Polygon
import java.io.File
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.UUID

@Composable
fun CoworkerHome() {
    val context = LocalContext.current
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var pulseDue by remember { mutableStateOf(false) }
    var showPulse by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { LocationTracker.start(context) }

    LaunchedEffect(Unit) {
        if (LocationTracker.hasPermission(context)) LocationTracker.start(context)
        else permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        SyncEngine.flush()
        pulseDue = runCatching { Api.get<PulseStatus>("pulse/status").due }.getOrDefault(false)
    }

    val tabs = listOf(Triple(R.string.route, Icons.Filled.Map, 0), Triple(R.string.leads, Icons.Filled.People, 1), Triple(R.string.me, Icons.Filled.Insights, 2))
    Scaffold(
        bottomBar = {
            NavigationBar {
                tabs.forEach { (label, icon, i) ->
                    NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = { Icon(icon, contentDescription = null) }, label = { Text(stringResource(label)) })
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(bottom = padding.calculateBottomPadding()).fillMaxSize()) {
            // Weekly pulse is an in-app banner, never an after-hours push (spec 4.6).
            if (pulseDue) {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.fillMaxWidth().clickable { showPulse = true }) {
                    Row(Modifier.padding(top = padding.calculateTopPadding() + 8.dp, bottom = 8.dp, start = 16.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Favorite, contentDescription = null)
                        Text(stringResource(R.string.pulse_banner), fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
            Box(Modifier.weight(1f)) {
                when (tab) {
                    0 -> RouteScreen()
                    1 -> LeadsScreen()
                    else -> ScorecardScreen()
                }
            }
        }
    }
    if (showPulse) PulseDialog(onClose = { showPulse = false }, onDone = { pulseDue = false; showPulse = false })
}

/** Toolbar chip showing queued / flagged offline captures. */
@Composable
fun SyncChip() {
    val online by NetworkMonitor.online.collectAsState()
    val ops by SyncEngine.ops.collectAsState()
    val pending = ops.count { !it.conflicted }
    val conflicts = ops.count { it.conflicted }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(end = 8.dp)) {
        val offline = stringResource(R.string.offline)
        if (!online) Icon(Icons.Filled.WifiOff, contentDescription = offline)
        if (pending > 0) {
            val desc = stringResource(R.string.n_waiting_to_sync, pending)
            Row(Modifier.semantics(mergeDescendants = true) { contentDescription = desc }) { Icon(Icons.Filled.Sync, null); Text("$pending") }
        }
        if (conflicts > 0) {
            val desc = stringResource(R.string.n_need_attention, conflicts)
            Row(Modifier.semantics(mergeDescendants = true) { contentDescription = desc }) { Icon(Icons.Filled.Warning, null, tint = Color(0xFFB45309)); Text("$conflicts") }
        }
    }
}

// ---- Route map ----

@Composable
fun RouteScreen() {
    val scope = rememberCoroutineScope()
    var routes by remember { mutableStateOf<List<CanvassRoute>>(emptyList()) }
    var routeIndex by remember { mutableIntStateOf(0) }
    var areas by remember { mutableStateOf<List<ServiceArea>>(emptyList()) }
    var dnk by remember { mutableStateOf<List<DnkPoint>>(emptyList()) }
    var selected by remember { mutableStateOf<RouteStop?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val here by LocationTracker.location.collectAsState()
    val stops = routes.getOrNull(routeIndex)?.stops.orEmpty()

    suspend fun load() {
        try {
            routes = OfflineCache.get("routes/mine")
            error = null
        } catch (e: Exception) {
            error = e.message
        }
        areas = runCatching { OfflineCache.get<List<ServiceArea>>("service-area") }.getOrDefault(areas)
        dnk = runCatching { OfflineCache.get<List<DnkPoint>>("dnk/map") }.getOrDefault(dnk)
        // Warm the caches lead capture needs offline.
        runCatching { OfflineCache.get<ConsentTexts>("consent-texts") }
        runCatching { OfflineCache.get<List<CatalogItem>>("catalog") }
    }
    LaunchedEffect(Unit) { load() }

    Screen(
        stringResource(R.string.route),
        actions = {
            SyncChip()
            IconButton(onClick = { scope.launch { load() } }) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.refresh)) }
        },
    ) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) {
                RouteMap(areas, dnk, stops, here?.let { GeoPoint(it.latitude, it.longitude) }) { selected = it }
            }
            Surface(tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val route = routes.getOrNull(routeIndex)
                    if (route == null) {
                        Text(error ?: stringResource(R.string.no_route_today))
                    } else {
                        if (routes.size > 1) {
                            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                routes.forEachIndexed { i, r -> AssistChip(onClick = { routeIndex = i }, label = { Text(stringResource(R.string.route_and_date, r.name, r.routeDate)) }) }
                            }
                        } else {
                            Text(route.name, style = MaterialTheme.typography.titleMedium)
                        }
                        Text(
                            stringResource(R.string.doors_progress, stops.count { it.status == "knocked" }, stops.size, route.permitRef),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        // The same doors as the map pins, as a list (easier one-handed, and readable by screen readers).
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            stops.forEach { stop ->
                                AssistChip(
                                    onClick = { selected = stop },
                                    label = { Text(stop.address) },
                                    leadingIcon = { Icon(if (stop.doNotKnock == 1) Icons.Filled.PanTool else Icons.Filled.Home, contentDescription = null) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
    selected?.let { stop -> StopSheet(stop, onDismiss = { selected = null; scope.launch { load() } }) }
}

@Composable
fun RouteMap(areas: List<ServiceArea>, dnk: List<DnkPoint>, stops: List<RouteStop>, here: GeoPoint?, onSelect: (RouteStop) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val dnkLabel = stringResource(R.string.do_not_knock)
    val map = remember {
        MapView(context).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            controller.setZoom(14.0)
            controller.setCenter(GeoPoint(47.445, -122.29))
        }
    }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> map.onResume()
                Lifecycle.Event.ON_PAUSE -> map.onPause()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); map.onDetach() }
    }
    AndroidView(factory = { map }, modifier = Modifier.fillMaxSize()) { view ->
        view.overlays.clear()
        for (ring in areas.flatMap { it.rings }) {
            view.overlays.add(Polygon(view).apply {
                points = ring.map { (lat, lng) -> GeoPoint(lat, lng) }
                fillPaint.color = android.graphics.Color.argb(16, 11, 107, 203)
                outlinePaint.color = android.graphics.Color.rgb(11, 107, 203)
                outlinePaint.strokeWidth = 4f
            })
        }
        for (p in dnk) {
            view.overlays.add(Marker(view).apply {
                position = GeoPoint(p.lat, p.lng)
                icon = ContextCompat.getDrawable(context, R.drawable.ic_dnk)
                title = dnkLabel
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
            })
        }
        for (stop in stops) {
            val lat = stop.lat ?: continue
            val lng = stop.lng ?: continue
            view.overlays.add(Marker(view).apply {
                position = GeoPoint(lat, lng)
                icon = ContextCompat.getDrawable(context, if (stop.status == "knocked") R.drawable.ic_stop_done else R.drawable.ic_stop)
                title = stop.address
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
                setOnMarkerClickListener { _, _ -> onSelect(stop); true }
            })
        }
        here?.let { point ->
            view.overlays.add(Marker(view).apply {
                position = point
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
            })
        }
        view.invalidate()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StopSheet(stop: RouteStop, onDismiss: () -> Unit) {
    var captureLead by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val waiting = stringResource(R.string.waiting_for_gps)
    val checkInLabel = stringResource(R.string.check_in_label, stop.address)

    /** Geo-verified on the server against the property's coordinates; queued if offline. */
    fun checkIn(outcome: String): Boolean {
        val loc = LocationTracker.location.value ?: run { message = waiting; return false }
        SyncEngine.enqueue(
            "check-ins",
            mapOf(
                "id" to UUID.randomUUID().toString(), "property_id" to stop.propertyId, "route_stop_id" to stop.id, "outcome" to outcome,
                "lat" to loc.latitude, "lng" to loc.longitude, "client_created_at" to Fmt.iso(Instant.now()),
            ),
            label = checkInLabel,
        )
        return true
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(bottom = 24.dp)) {
            Text(stringResource(R.string.door), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 16.dp))
            Text(stop.address, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
            if (stop.doNotKnock == 1) {
                ListItem(
                    leadingContent = { Icon(Icons.Filled.PanTool, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                    headlineContent = { Text(stringResource(R.string.dnk_skip), color = MaterialTheme.colorScheme.error) },
                )
            } else {
                SectionHeader(stringResource(R.string.check_in_at_door))
                OutcomeRow(Icons.Filled.NotificationsOff, stringResource(R.string.no_answer)) { if (checkIn("no_answer")) onDismiss() }
                OutcomeRow(Icons.Filled.ThumbDown, stringResource(R.string.not_interested)) { if (checkIn("not_interested")) onDismiss() }
                OutcomeRow(Icons.Filled.Update, stringResource(R.string.come_back_later)) { if (checkIn("come_back")) onDismiss() }
                OutcomeRow(Icons.Filled.PersonAdd, stringResource(R.string.interested_capture)) { checkIn("interested"); captureLead = true }
                message?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp)) }
            }
        }
    }
    if (captureLead) LeadCaptureDialog(propertyId = stop.propertyId, initialAddress = stop.address, onClose = { captureLead = false; onDismiss() })
}

@Composable
private fun OutcomeRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    ListItem(leadingContent = { Icon(icon, contentDescription = null) }, headlineContent = { Text(label) }, modifier = Modifier.clickable(onClick = onClick))
}

// ---- Leads ----

@Composable
fun LeadsScreen() {
    var openLead by rememberSaveable { mutableStateOf<String?>(null) }
    var newLead by remember { mutableStateOf(false) }
    var leads by remember { mutableStateOf<List<LeadSummary>>(emptyList()) }
    val ops by SyncEngine.ops.collectAsState()
    val scope = rememberCoroutineScope()
    suspend fun load() { leads = runCatching { OfflineCache.get<List<LeadSummary>>("leads") }.getOrDefault(leads) }
    LaunchedEffect(ops.size) { load() }

    openLead?.let { id -> return LeadDetailScreen(id) { openLead = null } }

    Screen(
        stringResource(R.string.leads),
        actions = {
            SyncChip()
            IconButton(onClick = { newLead = true }) { Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.new_lead)) }
        },
    ) {
        Refreshable(leads, { SyncEngine.flush(); load() }) {
            LazyColumn(Modifier.fillMaxSize()) {
                if (ops.isNotEmpty()) {
                    item { SectionHeader(stringResource(R.string.waiting_to_sync)) }
                    items(ops, key = { it.id }) { op ->
                        ListItem(
                            headlineContent = { Text(op.label) },
                            supportingContent = {
                                Column {
                                    op.lastError?.let { Text(it, color = if (op.conflicted) Color(0xFFB45309) else MaterialTheme.colorScheme.onSurfaceVariant) }
                                    if (op.conflicted) Text(stringResource(R.string.sent_to_lead), style = MaterialTheme.typography.bodySmall)
                                }
                            },
                            trailingContent = { if (op.conflicted) TextButton(onClick = { SyncEngine.dismiss(op) }) { Text(stringResource(R.string.dismiss)) } },
                        )
                    }
                }
                item { SectionHeader(stringResource(R.string.my_leads)) }
                items(leads, key = { it.id }) { lead ->
                    ListItem(
                        headlineContent = { Text(lead.customerName ?: "—", fontWeight = FontWeight.SemiBold) },
                        supportingContent = { Text(lead.address) },
                        trailingContent = { StatusBadge(lead.status) },
                        modifier = Modifier.clickable { openLead = lead.id },
                    )
                    HorizontalDivider()
                }
            }
        }
    }
    if (newLead) LeadCaptureDialog(propertyId = null, initialAddress = null, onClose = { newLead = false; scope.launch { load() } })
}

/** Interest captured: contact, product interest, photo, TCPA consent + door-to-door disclosure, signature. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LeadCaptureDialog(propertyId: String?, initialAddress: String?, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf(initialAddress.orEmpty()) }
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var interests by remember { mutableStateOf(setOf("internet")) }
    var tcpa by remember { mutableStateOf(false) }
    var disclosure by remember { mutableStateOf(false) }
    var signature by remember { mutableStateOf<ByteArray?>(null) }
    var photo by remember { mutableStateOf<ByteArray?>(null) }
    var consent by remember { mutableStateOf<ConsentTexts?>(null) }
    var warning by remember { mutableStateOf<String?>(null) }
    var blocked by remember { mutableStateOf(false) }
    val dnkWarning = stringResource(R.string.dnk_warning)
    val outsideWarning = stringResource(R.string.outside_warning)
    val photoUri = remember {
        val dir = File(context.cacheDir, "photos").apply { mkdirs() }
        FileProvider.getUriForFile(context, "${context.packageName}.files", File(dir, "door.jpg"))
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) photo = ImageTools.jpeg(context, photoUri) }

    /** Online-only heads-up; the server enforces the same rules when the capture syncs. */
    suspend fun precheck() {
        val loc = LocationTracker.location.value
        if (propertyId != null || address.isBlank() || loc == null) return
        val res = runCatching { Api.post<PropertyCheck>("properties/validate", mapOf("address" to address, "lat" to loc.latitude, "lng" to loc.longitude)) }.getOrNull() ?: return
        blocked = res.doNotKnock
        warning = if (res.doNotKnock) dnkWarning else if (res.seatacValid) null else outsideWarning
    }

    LaunchedEffect(Unit) {
        consent = runCatching { OfflineCache.get<ConsentTexts>("consent-texts") }.getOrNull()
        if (propertyId == null && address.isEmpty()) LocationTracker.currentAddress(context)?.let { address = it }
        precheck()
    }

    val canSave = !blocked && address.isNotBlank() && name.isNotBlank() && (phone.isNotBlank() || email.contains("@")) &&
        tcpa && disclosure && signature != null && consent != null
    val leadLabel = stringResource(R.string.lead_label, name)

    fun save() {
        val now = Fmt.iso(Instant.now())
        val body = mutableMapOf<String, Any?>(
            "id" to UUID.randomUUID().toString(), "customer_name" to name, "product_interest" to interests.toList(),
            "tcpa_accepted" to tcpa, "disclosure_accepted" to disclosure, "consent_text_version" to consent?.version,
            "consented_at" to now, "client_created_at" to now,
        )
        if (propertyId != null) body["property_id"] = propertyId else body["address"] = address
        if (phone.isNotBlank()) body["phone"] = phone
        if (email.isNotBlank()) body["email"] = email.lowercase()
        LocationTracker.location.value?.let { body["lat"] = it.latitude; body["lng"] = it.longitude }
        SyncEngine.enqueue("leads", body, label = leadLabel, photo = photo, photoKind = "door_photo", signature = signature)
        onClose()
    }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(stringResource(R.string.new_lead)) },
                    navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.cancel)) } },
                    actions = { TextButton(onClick = ::save, enabled = canSave) { Text(stringResource(R.string.save)) } },
                )
            },
        ) { padding ->
            Column(Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
                SectionHeader(stringResource(R.string.address))
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it },
                    enabled = propertyId == null,
                    label = { Text(stringResource(R.string.street_address_hint)) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                )
                if (propertyId == null) {
                    TextButton(onClick = { scope.launch { LocationTracker.currentAddress(context)?.let { address = it }; precheck() } }, modifier = Modifier.padding(horizontal = 8.dp)) {
                        Icon(Icons.Filled.MyLocation, contentDescription = null)
                        Text(stringResource(R.string.use_my_location), modifier = Modifier.padding(start = 6.dp))
                    }
                }
                warning?.let {
                    Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (blocked) Icons.Filled.PanTool else Icons.Filled.LocationOff, contentDescription = null, tint = if (blocked) MaterialTheme.colorScheme.error else Color(0xFFB45309))
                        Text(it, color = if (blocked) MaterialTheme.colorScheme.error else Color(0xFFB45309), modifier = Modifier.padding(start = 6.dp))
                    }
                }

                SectionHeader(stringResource(R.string.customer))
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.full_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(phone, { phone = it }, label = { Text(stringResource(R.string.mobile_phone)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(email, { email = it }, label = { Text(stringResource(R.string.email_for_tracking)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth())
                }

                SectionHeader(stringResource(R.string.interested_in))
                listOf("internet" to R.string.kind_internet, "tv" to R.string.kind_tv, "bundle" to R.string.kind_bundle).forEach { (kind, label) ->
                    val on = kind in interests
                    Row(Modifier.fillMaxWidth().choice(on) { interests = if (on) interests - kind else interests + kind }.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(label), modifier = Modifier.weight(1f))
                        Checkbox(checked = on, onCheckedChange = null)
                    }
                }

                SectionHeader(stringResource(R.string.photo_optional))
                OutlinedButton(onClick = { camera.launch(photoUri) }, modifier = Modifier.padding(horizontal = 16.dp)) {
                    Icon(Icons.Filled.CameraAlt, contentDescription = null)
                    Text(stringResource(if (photo == null) R.string.take_door_photo else R.string.retake_photo), modifier = Modifier.padding(start = 6.dp))
                }
                photo?.let { bytes ->
                    remember(bytes) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }?.let {
                        Image(it, contentDescription = null, modifier = Modifier.padding(16.dp).heightIn(max = 160.dp))
                    }
                }

                SectionHeader(stringResource(R.string.consent))
                Text(consent?.body("d2d_disclosure").orEmpty(), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp))
                ToggleRow(stringResource(R.string.ack_disclosure), disclosure) { disclosure = it }
                Text(consent?.body("tcpa").orEmpty(), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp))
                ToggleRow(stringResource(R.string.agree_calls_texts), tcpa) { tcpa = it }
                SignaturePad { signature = it }
                Text(stringResource(R.string.consent_footer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
            }
        }
    }
}

@Composable
fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
fun LeadDetailScreen(leadId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var lead by remember { mutableStateOf<LeadDetail?>(null) }
    var service by remember { mutableStateOf<Serviceability?>(null) }
    var chosen by remember { mutableStateOf(setOf<String>()) }
    var appt by remember { mutableStateOf(LocalDateTime.now().plusDays(2).withHour(10).withMinute(0)) }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val apptSaved = stringResource(R.string.appointment_saved)
    val apptBooked = stringResource(R.string.appointment_booked)
    val orderSubmitted = stringResource(R.string.order_submitted)
    suspend fun load() { lead = runCatching { Api.get<LeadDetail>("leads/$leadId") }.getOrNull() }
    LaunchedEffect(leadId) { load() }

    fun apptInstant() = appt.atZone(ZoneId.systemDefault()).toInstant()

    fun pickDate() {
        DatePickerDialog(context, { _, y, m, d ->
            TimePickerDialog(context, { _, h, min -> appt = LocalDateTime.of(y, m + 1, d, h, min) }, appt.hour, appt.minute, false).show()
        }, appt.year, appt.monthValue - 1, appt.dayOfMonth).apply { datePicker.minDate = System.currentTimeMillis() }.show()
    }

    Screen(stringResource(R.string.lead), onBack = onBack) {
        val l = lead ?: return@Screen Loading()
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                LabeledRow(stringResource(R.string.customer), l.customerName ?: "—")
                LabeledRow(stringResource(R.string.phone), l.phone ?: "—")
                LabeledRow(stringResource(R.string.email), l.email ?: "—")
                LabeledRow(stringResource(R.string.address), l.address)
                ListItem(headlineContent = { Text(stringResource(R.string.status)) }, trailingContent = { StatusBadge(l.status) })
                if (l.seatacValid == 0) Text(stringResource(R.string.outside_pending_review), color = Color(0xFFB45309), modifier = Modifier.padding(16.dp))
                l.notServiceableReason?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
            }
            if (l.status !in setOf("order", "closed", "not_serviceable")) {
                item {
                    SectionHeader(stringResource(R.string.qualification))
                    TextButton(onClick = {
                        scope.launch {
                            try {
                                service = Api.post<Serviceability>("leads/$leadId/serviceability")
                                if (service?.serviceable == false) { message = service?.reason; load() }
                            } catch (e: Exception) { message = e.message }
                        }
                    }, modifier = Modifier.padding(horizontal = 8.dp)) { Text(stringResource(R.string.check_serviceability)) }
                }
                service?.takeIf { it.serviceable }?.let { s ->
                    items(s.items, key = { it.sku }) { item ->
                        val on = item.sku in chosen
                        ListItem(
                            headlineContent = { Text(item.localizedName) },
                            supportingContent = {
                                Column {
                                    Text(stringResource(R.string.per_month, Fmt.money(item.promoPriceCents ?: item.monthlyPriceCents)))
                                    item.commissionCents?.let { Text(stringResource(R.string.est_commission, Fmt.money(it)), style = MaterialTheme.typography.bodySmall) }
                                }
                            },
                            trailingContent = { Checkbox(checked = on, onCheckedChange = null) },
                            modifier = Modifier.choice(on) { chosen = if (on) chosen - item.sku else chosen + item.sku },
                        )
                    }
                }
                item {
                    SectionHeader(stringResource(R.string.appointment))
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.install_consult)) },
                        trailingContent = { Text(Fmt.date(Fmt.iso(apptInstant()), time = true)) },
                        modifier = Modifier.clickable(onClick = ::pickDate),
                    )
                    TextButton(onClick = {
                        val at = apptInstant()
                        SyncEngine.enqueue(
                            "appointments",
                            mapOf("id" to UUID.randomUUID().toString(), "lead_id" to leadId, "scheduled_at" to Fmt.iso(at), "window_end" to Fmt.iso(at.plusSeconds(7200)), "kind" to "install"),
                            label = apptBooked,
                        )
                        message = apptSaved
                        scope.launch { delay(1000); load() }
                    }, modifier = Modifier.padding(horizontal = 8.dp)) { Text(stringResource(R.string.book_appointment)) }
                    Button(
                        onClick = {
                            scope.launch {
                                busy = true
                                try {
                                    val at = apptInstant()
                                    Api.send("POST", "orders", mapOf(
                                        "id" to UUID.randomUUID().toString(), "lead_id" to leadId, "skus" to chosen.toList(), "customer_locale" to Lang.code,
                                        "install_window_start" to Fmt.iso(at), "install_window_end" to Fmt.iso(at.plusSeconds(7200)),
                                    ))
                                    message = orderSubmitted
                                    load()
                                } catch (e: Exception) {
                                    message = e.message
                                } finally {
                                    busy = false
                                }
                            }
                        },
                        enabled = chosen.isNotEmpty() && !busy,
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                    ) { if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.submit_order)) }
                    BillingNotice(stringResource(R.string.order_footer))
                }
            }
            if (l.appointments.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.appointments)) }
                items(l.appointments, key = { it.id }) { a ->
                    ListItem(headlineContent = { Text(Fmt.date(a.scheduledAt, time = true)) }, trailingContent = { StatusBadge(a.status) })
                }
            }
            message?.let { item { Text(it, modifier = Modifier.padding(16.dp)) } }
        }
    }
}
