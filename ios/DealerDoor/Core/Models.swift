import CoreLocation
import Foundation

// Mirrors the Worker JSON (snake_case is converted by the decoder).

enum Role: String, Codable {
    case customer, coworker, lead, office, admin
    var isStaff: Bool { self != .customer }
}

struct Tokens: Codable {
    let accessToken: String
    let refreshToken: String
}

struct LoginResponse: Decodable {
    let sent: Bool?
    let devToken: String?
    let accessToken: String?
    let refreshToken: String?
}

struct Me: Codable, Equatable {
    let id: String
    let email: String
    let role: Role
    let displayName: String?
    let locale: String?
    let crewId: String?
}

// MARK: Orders

struct BundleItem: Codable, Hashable {
    let sku: String
    let kind: String
    let name: String
    let monthlyPriceCents: Int
    let promoPriceCents: Int?
    let promoMonths: Int?
}

struct OrderBundle: Codable, Hashable {
    let items: [BundleItem]
    let monthlyTotalCents: Int
    let notice: String?
}

struct OrderSummary: Decodable, Identifiable {
    let id: String
    let status: String
    let installScheduledAt: String?
    let activatedAt: String?
    let createdAt: String
    let address: String?
    let bundle: OrderBundle
    let openInvoices: Int?
}

struct CustomerStage: Decodable, Identifiable {
    let key: String
    let label: String
    let status: String
    let completedAt: String?
    let note: String?
    let scheduledFor: String?
    var id: String { key }
}

struct CustomerOrder: Decodable {
    let id: String
    let status: String
    let address: String?
    let installScheduledAt: String?
    let bundle: OrderBundle
    let billingNotice: String
    let timeline: [CustomerStage]
    let feedbackUnlocked: Bool
}

// MARK: Invoices

struct Payment: Decodable, Identifiable {
    let id: String
    let amountCents: Int
    let method: String
    let status: String
    let createdAt: String
}

struct Invoice: Decodable, Identifiable {
    let id: String
    let orderId: String?
    let description: String
    let amountCents: Int
    let amountPaidCents: Int
    let paymentTermDays: Int
    let dueDate: String
    let status: String
    let payments: [Payment]?
    var balanceCents: Int { amountCents - amountPaidCents }
}

struct InvoiceList: Decodable {
    let invoices: [Invoice]
    let billingNotice: String
}

struct PayResponse: Decodable {
    let mode: String
    let clientSecret: String?
    let publishableKey: String?
}

// MARK: Feedback

struct FeedbackSummary: Decodable {
    let count: Int
    let overall: Double?
}

struct MyFeedback: Decodable, Identifiable {
    let id: String
    let orderId: String
    let salesRating: Int
    let installRating: Int
    let clarityRating: Int
    let supportRating: Int
    let comment: String?
    let status: String
}

// MARK: Field sales

struct RouteStop: Codable, Identifiable, Hashable {
    let id: String
    let routeId: String
    let sortOrder: Int?
    let status: String
    let propertyId: String
    let address: String
    let lat: Double?
    let lng: Double?
    let doNotKnock: Int
    var coordinate: CLLocationCoordinate2D? {
        guard let lat, let lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

struct CanvassRoute: Codable, Identifiable {
    let id: String
    let name: String
    let routeDate: String
    let permitRef: String
    let status: String
    let stops: [RouteStop]
}

struct DnkPoint: Codable, Identifiable {
    let id: String
    let lat: Double
    let lng: Double
}

/// GeoJSON Polygon or MultiPolygon, flattened to outer rings for drawing.
struct ServiceArea: Codable, Identifiable {
    let id: String
    let name: String
    let rings: [[CLLocationCoordinate2D]]

    private enum CodingKeys: String, CodingKey { case id, name, geojson }
    private struct Geo: Codable { let type: String }
    private struct Poly: Codable { let coordinates: [[[Double]]] }
    private struct Multi: Codable { var type = "MultiPolygon"; let coordinates: [[[[Double]]]] }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        let toCoords = { (ring: [[Double]]) in ring.map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) } }
        if try c.decode(Geo.self, forKey: .geojson).type == "MultiPolygon" {
            rings = try c.decode(Multi.self, forKey: .geojson).coordinates.compactMap { $0.first.map(toCoords) }
        } else {
            rings = try c.decode(Poly.self, forKey: .geojson).coordinates.prefix(1).map(toCoords)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(Multi(coordinates: rings.map { [$0.map { [$0.longitude, $0.latitude] }] }), forKey: .geojson)
    }
}

struct ConsentText: Codable {
    let version: String
    let kind: String
    let locale: String
    let body: String
}

struct ConsentTexts: Codable {
    let version: String
    let texts: [ConsentText]

    func body(_ kind: String) -> String {
        let lang = Locale.current.language.languageCode?.identifier == "es" ? "es" : "en"
        return texts.first { $0.kind == kind && $0.locale == lang }?.body ?? texts.first { $0.kind == kind }?.body ?? ""
    }
}

struct CatalogItem: Codable, Identifiable, Hashable {
    let id: String
    let sku: String
    let kind: String
    let name: String
    let nameEs: String?
    let speedMbps: Int?
    let monthlyPriceCents: Int
    let promoPriceCents: Int?
    let promoMonths: Int?
    let eligibilityNotes: String?
    let commissionCents: Int?
    var localizedName: String { Locale.current.language.languageCode?.identifier == "es" ? (nameEs ?? name) : name }
}

struct Serviceability: Decodable {
    let serviceable: Bool
    let reason: String?
    let items: [CatalogItem]
}

struct LeadSummary: Codable, Identifiable {
    let id: String
    let customerName: String?
    let status: String
    let address: String
    let createdAt: String
}

struct Appointment: Decodable, Identifiable {
    let id: String
    let kind: String
    let scheduledAt: String
    let status: String
}

struct LeadDetail: Decodable {
    let id: String
    let customerName: String?
    let phone: String?
    let email: String?
    let status: String
    let address: String
    let seatacValid: Int
    let notServiceableReason: String?
    let photoUrl: String?
    let appointments: [Appointment]
}

struct PropertyCheck: Decodable {
    let propertyId: String
    let seatacValid: Bool
    let doNotKnock: Bool
}

// MARK: People

struct PulseStatus: Decodable {
    let isoWeek: String
    let due: Bool
}

struct TrendPoint: Decodable, Identifiable {
    let isoWeek: String
    let n: Int
    let workload: Double?
    let safety: Double?
    let support: Double?
    var id: String { isoWeek }
}

struct Kudo: Decodable, Identifiable {
    let id: String
    let message: String
    let fromName: String?
    let createdAt: String
}

struct SalesStats: Decodable {
    let leads: Int
    let appointments: Int
    let orders: Int
    let activations: Int
}

struct Scorecard: Decodable {
    let trend: [TrendPoint]
    let kudos: [Kudo]
    let sales: SalesStats?
}

struct CrewScorecard: Decodable {
    let crewId: String?
    let trend: [TrendPoint]
}

struct Coworker: Decodable, Identifiable, Hashable {
    let id: String
    let displayName: String?
}

struct UploadTicket: Decodable {
    let key: String
    let uploadUrl: String
    let contentType: String
}

// MARK: Formatting

enum Fmt {
    static func money(_ cents: Int) -> String {
        (Double(cents) / 100).formatted(.currency(code: "USD"))
    }

    /// Accepts ISO-8601 and SQLite "YYYY-MM-DD HH:MM:SS" (UTC).
    static func date(_ s: String?, time: Bool = false) -> String {
        guard let s else { return "—" }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = iso.date(from: s)
            ?? ISO8601DateFormatter().date(from: s)
            ?? ISO8601DateFormatter().date(from: s.replacingOccurrences(of: " ", with: "T") + "Z")
        guard let d else { return s }
        return time ? d.formatted(date: .abbreviated, time: .shortened) : d.formatted(date: .abbreviated, time: .omitted)
    }

    /// Due dates are plain YYYY-MM-DD in Pacific time.
    static func day(_ s: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "America/Los_Angeles")
        return f.date(from: s)?.formatted(date: .abbreviated, time: .omitted) ?? s
    }
}
