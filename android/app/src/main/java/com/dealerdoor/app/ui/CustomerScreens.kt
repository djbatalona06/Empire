package com.dealerdoor.app.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Reviews
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dealerdoor.app.R
import com.dealerdoor.app.core.Api
import com.dealerdoor.app.core.Auth
import com.dealerdoor.app.core.CustomerOrder
import com.dealerdoor.app.core.CustomerStage
import com.dealerdoor.app.core.FeedbackSummary
import com.dealerdoor.app.core.Fmt
import com.dealerdoor.app.core.ImageTools
import com.dealerdoor.app.core.Invoice
import com.dealerdoor.app.core.InvoiceList
import com.dealerdoor.app.core.MyFeedback
import com.dealerdoor.app.core.OrderSummary
import com.dealerdoor.app.core.PayResponse
import com.stripe.android.PaymentConfiguration
import com.stripe.android.paymentsheet.PaymentSheet
import com.stripe.android.paymentsheet.PaymentSheetResult
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

@Composable
fun CustomerHome() {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val tabs = listOf(
        Triple(R.string.my_order, Icons.Filled.Inventory2, "orders"),
        Triple(R.string.invoices, Icons.Filled.Description, "invoices"),
        Triple(R.string.feedback, Icons.Filled.Reviews, "feedback"),
    )
    Scaffold(
        bottomBar = {
            NavigationBar {
                tabs.forEachIndexed { i, (label, icon, _) ->
                    NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = { Icon(icon, contentDescription = null) }, label = { Text(stringResource(label)) })
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(bottom = padding.calculateBottomPadding())) {
            when (tab) {
                0 -> OrdersTab()
                1 -> InvoicesTab()
                else -> FeedbackTab()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Screen(title: String, onBack: (() -> Unit)? = null, actions: @Composable () -> Unit = {}, content: @Composable () -> Unit) {
    onBack?.let { BackHandler(onBack = it) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back)) }
                },
                actions = { actions() },
            )
        },
    ) { padding -> Box(Modifier.padding(top = padding.calculateTopPadding()).fillMaxSize()) { content() } }
}

/** Account menu with "Sign out", shared by the customer and coworker home screens. */
@Composable
fun AccountMenu() {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) { Icon(Icons.Filled.AccountCircle, contentDescription = stringResource(R.string.account)) }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(text = { Text(stringResource(R.string.sign_out), color = MaterialTheme.colorScheme.error) }, onClick = { open = false; Auth.signOut() })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> Refreshable(value: T, reload: suspend () -> Unit, content: @Composable (T) -> Unit) {
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; reload(); refreshing = false } }) { content(value) }
}

// ---- Orders + timeline ----

@Composable
fun OrdersTab() {
    var openOrder by rememberSaveable { mutableStateOf<String?>(null) }
    openOrder?.let { id -> return OrderTimelineScreen(id) { openOrder = null } }

    Screen(stringResource(R.string.my_order), actions = { AccountMenu() }) {
        AsyncContent(load = { Api.get<List<OrderSummary>>("orders") }) { orders, reload ->
            Refreshable(orders, reload) {
                LazyColumn(Modifier.fillMaxSize()) {
                    if (orders.isEmpty()) item { EmptyState(stringResource(R.string.no_orders), stringResource(R.string.no_orders_body)) }
                    items(orders, key = { it.id }) { order ->
                        OrderCard(order, Modifier.clickable { openOrder = order.id })
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

@Composable
fun OrderCard(order: OrderSummary, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(order.bundle.items.joinToString(" + ") { it.name }, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            StatusBadge(order.status)
        }
        order.address?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        order.installScheduledAt?.let {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.CalendarMonth, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.install_at, Fmt.date(it, time = true)), modifier = Modifier.padding(start = 6.dp))
            }
        }
        if ((order.openInvoices ?: 0) > 0) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Error, contentDescription = null, tint = Color(0xFFB45309), modifier = Modifier.size(16.dp))
                Text(stringResource(R.string.invoice_due), color = Color(0xFFB45309), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 4.dp))
            }
        }
    }
}

@Composable
fun OrderTimelineScreen(orderId: String, onBack: () -> Unit) {
    Screen(stringResource(R.string.order_status), onBack = onBack) {
        AsyncContent(key = orderId, load = { Api.get<CustomerOrder>("orders/$orderId") }) { order, reload ->
            Refreshable(order, reload) {
                LazyColumn(Modifier.fillMaxSize()) {
                    itemsIndexed(order.timeline, key = { _, s -> s.key }) { i, stage -> TimelineRow(stage, isLast = i == order.timeline.lastIndex) }
                    item { SectionHeader(stringResource(R.string.your_plan)) }
                    items(order.bundle.items, key = { it.sku }) { item ->
                        LabeledRow(item.name, stringResource(R.string.per_month, Fmt.money(item.promoPriceCents ?: item.monthlyPriceCents)))
                    }
                    item { BillingNotice(order.billingNotice) }
                }
            }
        }
    }
}

@Composable
fun TimelineRow(stage: CustomerStage, isLast: Boolean) {
    val (icon, color) = when (stage.status) {
        "complete" -> Icons.Filled.CheckCircle to Color(0xFF1B873F)
        "delayed" -> Icons.Filled.Warning to Color(0xFFB45309)
        "in_progress" -> Icons.Filled.Schedule to Brand
        else -> Icons.Filled.RadioButtonUnchecked to MaterialTheme.colorScheme.outline
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, contentDescription = statusLabel(stage.status), tint = color, modifier = Modifier.padding(top = 10.dp).size(24.dp))
            if (!isLast) VerticalDivider(Modifier.height(28.dp).padding(top = 2.dp), thickness = 2.dp, color = color.copy(alpha = 0.4f))
        }
        Column(Modifier.padding(vertical = 10.dp)) {
            Text(stage.label, style = MaterialTheme.typography.titleSmall)
            when {
                stage.scheduledFor != null -> Text(Fmt.date(stage.scheduledFor, time = true))
                stage.completedAt != null -> Text(Fmt.date(stage.completedAt), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            stage.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

// ---- Invoices + payment ----

@Composable
fun InvoicesTab() {
    var openInvoice by rememberSaveable { mutableStateOf<String?>(null) }
    openInvoice?.let { id -> return InvoiceDetailScreen(id) { openInvoice = null } }

    Screen(stringResource(R.string.invoices)) {
        AsyncContent(load = { Api.get<InvoiceList>("invoices") }) { list, reload ->
            Refreshable(list, reload) {
                LazyColumn(Modifier.fillMaxSize()) {
                    if (list.invoices.isEmpty()) item { EmptyState(stringResource(R.string.no_invoices), stringResource(R.string.no_invoices_body)) }
                    items(list.invoices, key = { it.id }) { inv ->
                        ListItem(
                            headlineContent = { Text(inv.description, fontWeight = FontWeight.SemiBold) },
                            supportingContent = { Text(stringResource(R.string.amount_due_on, Fmt.money(inv.balanceCents), Fmt.day(inv.dueDate))) },
                            trailingContent = { StatusBadge(inv.status) },
                            modifier = Modifier.clickable { openInvoice = inv.id },
                        )
                        HorizontalDivider()
                    }
                    item { BillingNotice(list.billingNotice) }
                }
            }
        }
    }
}

@Composable
fun InvoiceDetailScreen(invoiceId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var invoice by remember { mutableStateOf<Invoice?>(null) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val submitted = stringResource(R.string.payment_submitted)
    suspend fun load() { invoice = runCatching { Api.get<Invoice>("invoices/$invoiceId") }.getOrNull() }

    val paymentSheet = remember {
        PaymentSheet.Builder { result ->
            when (result) {
                is PaymentSheetResult.Completed -> message = submitted
                is PaymentSheetResult.Failed -> message = result.error.message
                is PaymentSheetResult.Canceled -> Unit
            }
            scope.launch { load() }
        }
    }.build()

    fun pay(method: String) = scope.launch {
        busy = true
        try {
            val res = Api.post<PayResponse>("invoices/$invoiceId/pay", mapOf("method" to method))
            if (res.mode != "stripe" || res.clientSecret == null || res.publishableKey == null) {
                load() // sandbox mode settles instantly
            } else {
                PaymentConfiguration.init(context, res.publishableKey)
                val config = PaymentSheet.Configuration.Builder("DealerDoor").allowsDelayedPaymentMethods(true).build() // ACH settles in days
                paymentSheet.presentWithPaymentIntent(res.clientSecret, config)
            }
        } catch (e: Exception) {
            message = e.message
        } finally {
            busy = false
        }
    }

    androidx.compose.runtime.LaunchedEffect(invoiceId) { load() }
    Screen(stringResource(R.string.invoice), onBack = onBack) {
        val inv = invoice ?: return@Screen Loading()
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                LabeledRow(stringResource(R.string.description), inv.description)
                LabeledRow(stringResource(R.string.amount), Fmt.money(inv.amountCents))
                LabeledRow(stringResource(R.string.paid), Fmt.money(inv.amountPaidCents))
                LabeledRow(stringResource(R.string.balance), Fmt.money(inv.balanceCents), bold = true)
                LabeledRow(stringResource(R.string.due), Fmt.day(inv.dueDate))
                LabeledRow(stringResource(R.string.terms), if (inv.paymentTermDays == 0) stringResource(R.string.due_on_receipt) else stringResource(R.string.net_days, inv.paymentTermDays))
                ListItem(headlineContent = { Text(stringResource(R.string.status)) }, trailingContent = { StatusBadge(inv.status) })
            }
            if (inv.status != "paid") item {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { pay("card") }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Filled.CreditCard, contentDescription = null)
                        Text(stringResource(R.string.pay_card), modifier = Modifier.padding(start = 8.dp))
                    }
                    OutlinedButton(onClick = { pay("ach") }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Filled.AccountBalance, contentDescription = null)
                        Text(stringResource(R.string.pay_ach), modifier = Modifier.padding(start = 8.dp))
                    }
                    Text(stringResource(R.string.payment_secure_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            val payments = inv.payments.orEmpty()
            if (payments.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.payments)) }
                items(payments, key = { it.id }) { p ->
                    ListItem(headlineContent = { Text(Fmt.money(p.amountCents)) }, supportingContent = { Text(Fmt.date(p.createdAt)) }, trailingContent = { StatusBadge(p.status) })
                }
            }
            message?.let { item { Text(it, modifier = Modifier.padding(16.dp)) } }
            item { BillingNotice(stringResource(R.string.att_billed_separately)) }
        }
    }
}

// ---- Feedback ----

private data class FeedbackData(val orders: List<OrderSummary>, val mine: List<MyFeedback>, val summary: FeedbackSummary)

@Composable
fun FeedbackTab() {
    Screen(stringResource(R.string.feedback)) {
        AsyncContent(load = {
            coroutineScope {
                val orders = async { Api.get<List<OrderSummary>>("orders") }
                val mine = async { Api.get<List<MyFeedback>>("feedback/customer/mine") }
                val summary = async { Api.get<FeedbackSummary>("feedback/summary") }
                FeedbackData(orders.await(), mine.await(), summary.await())
            }
        }) { data, reload ->
            val open = data.orders.filter { it.activatedAt != null && data.mine.none { f -> f.orderId == it.id } }
            Refreshable(data, reload) {
                LazyColumn(Modifier.fillMaxSize()) {
                    val overall = data.summary.overall
                    if (overall != null && data.summary.count > 0) item {
                        ListItem(
                            leadingContent = { Icon(Icons.Filled.Star, contentDescription = null, tint = Color(0xFFF5B400)) },
                            headlineContent = { Text(stringResource(R.string.customers_rate_us, overall, data.summary.count)) },
                        )
                    }
                    val first = open.firstOrNull()
                    if (first != null) {
                        item { SectionHeader(stringResource(R.string.rate_experience)) }
                        item { FeedbackForm(first.id, onDone = reload) }
                    } else if (data.mine.isEmpty()) {
                        item { EmptyState(stringResource(R.string.feedback_locked), stringResource(R.string.feedback_locked_body)) }
                    }
                    if (data.mine.isNotEmpty()) {
                        item { SectionHeader(stringResource(R.string.your_feedback)) }
                        items(data.mine, key = { it.id }) { f ->
                            ListItem(
                                headlineContent = { Text(stringResource(R.string.feedback_scores, f.salesRating, f.installRating, f.clarityRating, f.supportRating)) },
                                supportingContent = if (f.comment != null) { { Text(f.comment) } } else null,
                                trailingContent = { StatusBadge(f.status) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun FeedbackForm(orderId: String, onDone: suspend () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var sales by remember { mutableIntStateOf(0) }
    var install by remember { mutableIntStateOf(0) }
    var clarity by remember { mutableIntStateOf(0) }
    var support by remember { mutableIntStateOf(0) }
    var comment by remember { mutableStateOf("") }
    var photo by remember { mutableStateOf<ByteArray?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> uri?.let { photo = ImageTools.jpeg(context, it) } }

    Column {
        StarRating(stringResource(R.string.rate_sales), sales) { sales = it }
        StarRating(stringResource(R.string.rate_install), install) { install = it }
        StarRating(stringResource(R.string.rate_clarity), clarity) { clarity = it }
        StarRating(stringResource(R.string.rate_support), support) { support = it }
        OutlinedTextField(
            value = comment,
            onValueChange = { comment = it },
            label = { Text(stringResource(R.string.comments_optional)) },
            minLines = 3,
            supportingText = { Text("${comment.length}/1000", color = if (comment.length > 1000) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        )
        OutlinedButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, modifier = Modifier.padding(horizontal = 16.dp)) {
            Icon(if (photo == null) Icons.Filled.Photo else Icons.Filled.CheckCircle, contentDescription = null)
            Text(stringResource(if (photo == null) R.string.add_photo_optional else R.string.photo_added), modifier = Modifier.padding(start = 8.dp))
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
        Button(
            onClick = {
                scope.launch {
                    busy = true
                    try {
                        val body = mutableMapOf<String, Any?>("order_id" to orderId, "sales_rating" to sales, "install_rating" to install, "clarity_rating" to clarity, "support_rating" to support)
                        if (comment.isNotEmpty()) body["comment"] = comment
                        photo?.let { body["photo_key"] = Api.upload(it, "feedback_photo") }
                        Api.send("POST", "feedback/customer", body)
                        onDone()
                    } catch (e: Exception) {
                        error = e.message
                    } finally {
                        busy = false
                    }
                }
            },
            enabled = !busy && listOf(sales, install, clarity, support).none { it == 0 } && comment.length <= 1000,
            modifier = Modifier.fillMaxWidth().padding(16.dp),
        ) {
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.submit_feedback))
        }
    }
}
