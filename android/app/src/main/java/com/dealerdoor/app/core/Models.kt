package com.dealerdoor.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import java.util.Locale

// Mirrors the Worker JSON. Field names are camelCase here; the Json config maps them to snake_case.

@Serializable
enum class Role {
    customer, coworker, lead, office, admin;

    val isStaff: Boolean get() = this != customer
}

@Serializable
data class Tokens(val accessToken: String, val refreshToken: String)

@Serializable
data class LoginResponse(
    val sent: Boolean? = null,
    val devToken: String? = null,
    val accessToken: String? = null,
    val refreshToken: String? = null,
)

@Serializable
data class Me(
    val id: String,
    val email: String,
    val role: Role,
    val displayName: String? = null,
    val locale: String? = null,
    val crewId: String? = null,
)

// ---- Orders ----

@Serializable
data class BundleItem(
    val sku: String,
    val kind: String,
    val name: String,
    val monthlyPriceCents: Int,
    val promoPriceCents: Int? = null,
    val promoMonths: Int? = null,
)

@Serializable
data class OrderBundle(val items: List<BundleItem>, val monthlyTotalCents: Int, val notice: String? = null)

@Serializable
data class OrderSummary(
    val id: String,
    val status: String,
    val installScheduledAt: String? = null,
    val activatedAt: String? = null,
    val createdAt: String,
    val address: String? = null,
    val bundle: OrderBundle,
    val openInvoices: Int? = null,
)

@Serializable
data class CustomerStage(
    val key: String,
    val label: String,
    val status: String,
    val completedAt: String? = null,
    val note: String? = null,
    val scheduledFor: String? = null,
)

@Serializable
data class CustomerOrder(
    val id: String,
    val status: String,
    val address: String? = null,
    val installScheduledAt: String? = null,
    val bundle: OrderBundle,
    val billingNotice: String,
    val timeline: List<CustomerStage>,
    val feedbackUnlocked: Boolean,
    // Older servers do not send these.
    val cancelEligible: Boolean = false,
    val cancelDeadline: String? = null,
    val cancelRequestedAt: String? = null,
)

// ---- Invoices ----

@Serializable
data class Payment(val id: String, val amountCents: Int, val method: String, val status: String, val createdAt: String)

@Serializable
data class Invoice(
    val id: String,
    val orderId: String? = null,
    val description: String,
    val amountCents: Int,
    val amountPaidCents: Int,
    val paymentTermDays: Int,
    val dueDate: String,
    val status: String,
    val payments: List<Payment>? = null,
) {
    val balanceCents: Int get() = amountCents - amountPaidCents
}

@Serializable
data class InvoiceList(val invoices: List<Invoice>, val billingNotice: String)

@Serializable
data class PayResponse(val mode: String, val clientSecret: String? = null, val publishableKey: String? = null)

// ---- Feedback ----

@Serializable
data class FeedbackSummary(val count: Int, val overall: Double? = null)

@Serializable
data class MyFeedback(
    val id: String,
    val orderId: String,
    val salesRating: Int,
    val installRating: Int,
    val clarityRating: Int,
    val supportRating: Int,
    val comment: String? = null,
    val status: String,
)

// ---- Field sales ----

@Serializable
data class RouteStop(
    val id: String,
    val routeId: String,
    val sortOrder: Int? = null,
    val status: String,
    val propertyId: String,
    val address: String,
    val lat: Double? = null,
    val lng: Double? = null,
    val doNotKnock: Int,
)

@Serializable
data class CanvassRoute(
    val id: String,
    val name: String,
    val routeDate: String,
    val permitRef: String,
    val status: String,
    val stops: List<RouteStop>,
)

@Serializable
data class DnkPoint(val id: String, val lat: Double, val lng: Double)

/** GeoJSON Polygon or MultiPolygon. [rings] flattens it to outer rings of (lat, lng) for drawing. */
@Serializable
data class ServiceArea(val id: String, val name: String, val geojson: JsonObject) {
    val rings: List<List<Pair<Double, Double>>>
        get() {
            fun ring(e: JsonElement) = e.jsonArray.map { p -> p.jsonArray[1].jsonPrimitive.double to p.jsonArray[0].jsonPrimitive.double }
            val coords = geojson["coordinates"]?.jsonArray ?: return emptyList()
            return if (geojson["type"]?.jsonPrimitive?.content == "MultiPolygon") {
                coords.mapNotNull { poly -> poly.jsonArray.firstOrNull()?.let(::ring) }
            } else {
                coords.take(1).map(::ring)
            }
        }
}

@Serializable
data class ConsentText(val version: String, val kind: String, val locale: String, val body: String)

@Serializable
data class ConsentTexts(val version: String, val texts: List<ConsentText>) {
    fun body(kind: String): String =
        texts.firstOrNull { it.kind == kind && it.locale == Lang.code }?.body ?: texts.firstOrNull { it.kind == kind }?.body ?: ""
}

@Serializable
data class CatalogItem(
    val id: String,
    val sku: String,
    val kind: String,
    val name: String,
    val nameEs: String? = null,
    val speedMbps: Int? = null,
    val monthlyPriceCents: Int,
    val promoPriceCents: Int? = null,
    val promoMonths: Int? = null,
    val eligibilityNotes: String? = null,
    val commissionCents: Int? = null,
) {
    val localizedName: String get() = if (Lang.code == "es") nameEs ?: name else name
}

@Serializable
data class Serviceability(val serviceable: Boolean, val reason: String? = null, val items: List<CatalogItem> = emptyList())

@Serializable
data class LeadSummary(val id: String, val customerName: String? = null, val status: String, val address: String, val createdAt: String)

@Serializable
data class Appointment(val id: String, val kind: String, val scheduledAt: String, val status: String)

@Serializable
data class LeadDetail(
    val id: String,
    val customerName: String? = null,
    val phone: String? = null,
    val email: String? = null,
    val status: String,
    val address: String,
    val seatacValid: Int,
    val notServiceableReason: String? = null,
    val photoUrl: String? = null,
    val appointments: List<Appointment> = emptyList(),
)

@Serializable
data class PropertyCheck(val propertyId: String, val seatacValid: Boolean, val doNotKnock: Boolean)

// ---- People ----

@Serializable
data class PulseStatus(val isoWeek: String, val due: Boolean)

@Serializable
data class TrendPoint(
    val isoWeek: String,
    val n: Int,
    val workload: Double? = null,
    val safety: Double? = null,
    val support: Double? = null,
)

@Serializable
data class Kudo(val id: String, val message: String, val fromName: String? = null, val createdAt: String)

@Serializable
data class SalesStats(val leads: Int, val appointments: Int, val orders: Int, val activations: Int)

@Serializable
data class Scorecard(val trend: List<TrendPoint>, val kudos: List<Kudo>, val sales: SalesStats? = null)

@Serializable
data class CrewScorecard(val crewId: String? = null, val trend: List<TrendPoint>)

@Serializable
data class Coworker(val id: String, val displayName: String? = null)

@Serializable
data class UploadTicket(val key: String, val uploadUrl: String, val contentType: String)

/** "es" when the phone is set to Spanish, otherwise "en" (the two languages the Worker supports). */
object Lang {
    val code: String get() = if (Locale.getDefault().language == "es") "es" else "en"
}
