import MapKit
import PhotosUI
import SwiftUI

struct CoworkerHomeView: View {
    @State private var showPulse = false
    @State private var pulseDue = false
    private let sync = SyncEngine.shared

    var body: some View {
        TabView {
            NavigationStack { RouteMapView() }
                .tabItem { Label("Route", systemImage: "map") }
            NavigationStack { LeadsView() }
                .tabItem { Label("Leads", systemImage: "person.2") }
            NavigationStack { ScorecardView() }
                .tabItem { Label("Me", systemImage: "chart.line.uptrend.xyaxis") }
        }
        // Weekly pulse is an in-app banner, never an after-hours push (spec 4.6).
        .safeAreaInset(edge: .top) {
            if pulseDue {
                Button { showPulse = true } label: {
                    Label("Weekly check-in: 3 quick questions", systemImage: "heart.text.square")
                        .font(.subheadline.bold()).frame(maxWidth: .infinity).padding(10)
                        .background(.tint.opacity(0.15))
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $showPulse) { PulseView { pulseDue = false } }
        .task {
            LocationManager.shared.start()
            sync.refreshCounts()
            await sync.flush()
            pulseDue = ((try? await APIClient.shared.get("pulse/status") as PulseStatus)?.due) ?? false
        }
    }
}

/// Toolbar chip showing queued / flagged offline captures.
struct SyncChip: View {
    private let sync = SyncEngine.shared
    private let net = NetworkMonitor.shared

    var body: some View {
        HStack(spacing: 6) {
            if !net.isOnline { Image(systemName: "wifi.slash").accessibilityLabel(Text("Offline")) }
            if sync.pendingCount > 0 { Label("\(sync.pendingCount)", systemImage: "arrow.triangle.2.circlepath").accessibilityLabel(Text("\(sync.pendingCount) waiting to sync")) }
            if sync.conflictCount > 0 { Label("\(sync.conflictCount)", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityLabel(Text("\(sync.conflictCount) need attention")) }
        }
        .font(.caption.bold())
    }
}

// MARK: Route map

struct RouteMapView: View {
    @State private var routes: [CanvassRoute] = []
    @State private var routeIndex = 0
    @State private var areas: [ServiceArea] = []
    @State private var dnk: [DnkPoint] = []
    @State private var selected: RouteStop?
    @State private var position: MapCameraPosition = .region(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 47.445, longitude: -122.29), span: MKCoordinateSpan(latitudeDelta: 0.09, longitudeDelta: 0.09)))
    @State private var error: String?

    private var stops: [RouteStop] { routes.indices.contains(routeIndex) ? routes[routeIndex].stops : [] }

    var body: some View {
        Map(position: $position) {
            UserAnnotation()
            ForEach(Array(areas.flatMap(\.rings).enumerated()), id: \.offset) { _, ring in
                MapPolygon(coordinates: ring).foregroundStyle(.blue.opacity(0.06)).stroke(.blue, lineWidth: 2)
            }
            ForEach(dnk) { p in
                Annotation("Do not knock", coordinate: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lng)) {
                    Image(systemName: "hand.raised.fill").foregroundStyle(.white).padding(5).background(.red, in: Circle())
                }
            }
            ForEach(stops.filter { $0.coordinate != nil }) { stop in
                Annotation(stop.address, coordinate: stop.coordinate!) {
                    Button { selected = stop } label: {
                        Image(systemName: stop.status == "knocked" ? "checkmark.circle.fill" : "house.circle.fill")
                            .font(.title).foregroundStyle(stop.status == "knocked" ? .green : .blue).background(.white, in: Circle())
                    }
                    .accessibilityLabel(Text(stop.address))
                }
            }
        }
        .mapControls { MapUserLocationButton(); MapCompass() }
        .safeAreaInset(edge: .bottom) {
            if routes.isEmpty {
                Text(error ?? String(localized: "No route assigned today.")).font(.subheadline).padding().frame(maxWidth: .infinity).background(.regularMaterial)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    if routes.count > 1 {
                        Picker("Route", selection: $routeIndex) { ForEach(routes.indices, id: \.self) { Text("\(routes[$0].name) · \(routes[$0].routeDate)").tag($0) } }
                    } else {
                        Text(routes[routeIndex].name).font(.headline)
                    }
                    Text("\(stops.filter { $0.status == "knocked" }.count) of \(stops.count) doors · Permit \(routes[routeIndex].permitRef)").font(.caption).foregroundStyle(.secondary)
                }
                .padding().frame(maxWidth: .infinity, alignment: .leading).background(.regularMaterial)
            }
        }
        .navigationTitle("Route")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel(Text("Refresh")) }
            ToolbarItem(placement: .topBarTrailing) { SyncChip() }
        }
        .sheet(item: $selected) { stop in StopSheet(stop: stop) { Task { await load() } }.presentationDetents([.medium, .large]) }
        .task { await load() }
    }

    private func load() async {
        do {
            routes = try await OfflineCache.get("routes/mine")
            error = nil
        } catch { self.error = error.localizedDescription }
        areas = (try? await OfflineCache.get("service-area")) ?? areas
        dnk = (try? await OfflineCache.get("dnk/map")) ?? dnk
        // Warm the caches lead capture needs offline.
        _ = try? await OfflineCache.get("consent-texts", as: ConsentTexts.self)
        _ = try? await OfflineCache.get("catalog", as: [CatalogItem].self)
    }
}

struct StopSheet: View {
    let stop: RouteStop
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var captureLead = false
    @State private var message: LocalizedStringKey?

    var body: some View {
        NavigationStack {
            List {
                Section { Text(stop.address).font(.headline) }
                if stop.doNotKnock == 1 {
                    Label("Do not knock. Skip this address.", systemImage: "hand.raised.fill").foregroundStyle(.red)
                } else {
                    Section("Check in at the door") {
                        Button { checkIn("no_answer") } label: { Label("No answer", systemImage: "bell.slash") }
                        Button { checkIn("not_interested") } label: { Label("Not interested", systemImage: "hand.thumbsdown") }
                        Button { checkIn("come_back") } label: { Label("Come back later", systemImage: "clock.arrow.circlepath") }
                        Button { checkIn("interested"); captureLead = true } label: { Label("Interested: capture lead", systemImage: "person.badge.plus") }
                    }
                    if let message { Text(message).font(.footnote) }
                }
            }
            .navigationTitle("Door")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $captureLead, onDismiss: { dismiss(); onDone() }) {
                LeadCaptureView(propertyId: stop.propertyId, address: stop.address)
            }
        }
    }

    /// Geo-verified on the server against the property's coordinates; queued if offline.
    private func checkIn(_ outcome: String) {
        guard let loc = LocationManager.shared.location else { message = "Waiting for GPS. Step outside and try again."; return }
        SyncEngine.shared.enqueue("check-ins", [
            "id": UUID().uuidString.lowercased(), "property_id": stop.propertyId, "route_stop_id": stop.id, "outcome": outcome,
            "lat": loc.coordinate.latitude, "lng": loc.coordinate.longitude, "client_created_at": ISO8601DateFormatter().string(from: .now),
        ], label: String(localized: "Check-in: \(stop.address)"))
        if outcome != "interested" { dismiss(); onDone() }
    }
}

// MARK: Leads

struct LeadsView: View {
    @State private var leads: [LeadSummary] = []
    @State private var newLead = false
    private let sync = SyncEngine.shared

    var body: some View {
        List {
            let ops = sync.ops()
            let _ = (sync.pendingCount, sync.conflictCount) // re-render when the queue changes
            if !ops.isEmpty {
                Section("Waiting to sync") {
                    ForEach(ops) { op in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(op.label).font(.subheadline)
                            if op.conflicted {
                                Text(op.lastError ?? "").font(.caption).foregroundStyle(.orange)
                                Text("Sent to your team lead for review.").font(.caption2).foregroundStyle(.secondary)
                            } else if let err = op.lastError {
                                Text(err).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions { if op.conflicted { Button("Dismiss") { sync.dismiss(op) } } }
                    }
                }
            }
            Section("My leads") {
                ForEach(leads) { lead in
                    NavigationLink { LeadDetailView(leadId: lead.id) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack { Text(lead.customerName ?? "—").font(.headline); Spacer(); StatusBadge(status: lead.status) }
                            Text(lead.address).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Leads")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { SyncChip() }
            ToolbarItem(placement: .topBarTrailing) { Button { newLead = true } label: { Image(systemName: "plus") }.accessibilityLabel(Text("New lead")) }
        }
        .sheet(isPresented: $newLead, onDismiss: { Task { await load() } }) { LeadCaptureView(propertyId: nil, address: nil) }
        .task { await load() }
        .refreshable { await sync.flush(); await load() }
    }

    private func load() async {
        leads = (try? await OfflineCache.get("leads")) ?? leads
    }
}

/// Interest captured: contact, product interest, photo, TCPA consent + door-to-door disclosure, signature.
struct LeadCaptureView: View {
    let propertyId: String?
    @State var address: String?
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var phone = ""
    @State private var email = ""
    @State private var interests: Set<String> = ["internet"]
    @State private var tcpa = false
    @State private var disclosure = false
    @State private var signature: Data?
    @State private var photo: UIImage?
    @State private var showCamera = false
    @State private var consent: ConsentTexts?
    @State private var warning: LocalizedStringKey?
    @State private var blocked = false

    init(propertyId: String?, address: String?) {
        self.propertyId = propertyId
        _address = State(initialValue: address)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Address") {
                    TextField("Street address, SeaTac, WA", text: Binding(get: { address ?? "" }, set: { address = $0 }), axis: .vertical)
                        .disabled(propertyId != nil)
                    if propertyId == nil {
                        Button { Task { address = await LocationManager.shared.currentAddress(); await precheck() } } label: { Label("Use my location", systemImage: "location") }
                    }
                    if let warning { Label(warning, systemImage: "exclamationmark.triangle.fill").foregroundStyle(blocked ? .red : .orange) }
                }
                Section("Customer") {
                    TextField("Full name", text: $name).textContentType(.name)
                    TextField("Mobile phone", text: $phone).keyboardType(.phonePad).textContentType(.telephoneNumber)
                    TextField("Email (needed to track the order)", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section("Interested in") {
                    ForEach(["internet", "tv", "bundle"], id: \.self) { kind in
                        Toggle(LocalizedStringKey(kind), isOn: Binding(get: { interests.contains(kind) }, set: { if $0 { _ = interests.insert(kind) } else { _ = interests.remove(kind) } }))
                    }
                }
                Section("Photo (optional)") {
                    Button { showCamera = true } label: { Label(photo == nil ? LocalizedStringKey("Take door photo") : "Retake photo", systemImage: "camera") }
                    if let photo { Image(uiImage: photo).resizable().scaledToFit().frame(maxHeight: 160) }
                }
                Section {
                    Text(consent?.body("d2d_disclosure") ?? "").font(.footnote)
                    Toggle("Customer acknowledges the disclosure", isOn: $disclosure)
                    Text(consent?.body("tcpa") ?? "").font(.footnote)
                    Toggle("Customer agrees to calls and texts", isOn: $tcpa)
                    SignaturePad(png: $signature)
                } header: {
                    Text("Consent")
                } footer: {
                    Text("Read both statements to the customer. Consent is saved with the time, your rep ID, and this address.")
                }
            }
            .navigationTitle("New lead")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(!canSave) }
            }
            .fullScreenCover(isPresented: $showCamera) { CameraPicker(image: $photo).ignoresSafeArea() }
            .task {
                consent = try? await OfflineCache.get("consent-texts")
                if propertyId == nil, address == nil { address = await LocationManager.shared.currentAddress() }
                await precheck()
            }
        }
    }

    private var canSave: Bool {
        !blocked && !(address ?? "").isEmpty && !name.isEmpty && (!phone.isEmpty || email.contains("@")) && tcpa && disclosure && signature != nil && consent != nil
    }

    /// Online-only heads-up; the server enforces the same rules when the capture syncs.
    private func precheck() async {
        guard propertyId == nil, let address, !address.isEmpty, let loc = LocationManager.shared.location else { return }
        guard let res: PropertyCheck = try? await APIClient.shared.post("properties/validate", ["address": address, "lat": loc.coordinate.latitude, "lng": loc.coordinate.longitude]) else { return }
        blocked = res.doNotKnock
        warning = res.doNotKnock ? "This address is on the do-not-knock list." : (res.seatacValid ? nil : "Outside the SeaTac area. It will be flagged for review.")
    }

    private func save() {
        let now = ISO8601DateFormatter().string(from: .now)
        var body: [String: Any] = [
            "id": UUID().uuidString.lowercased(), "customer_name": name, "product_interest": Array(interests),
            "tcpa_accepted": tcpa, "disclosure_accepted": disclosure, "consent_text_version": consent!.version,
            "consented_at": now, "client_created_at": now,
        ]
        if let propertyId { body["property_id"] = propertyId } else { body["address"] = address }
        if !phone.isEmpty { body["phone"] = phone }
        if !email.isEmpty { body["email"] = email.lowercased() }
        if let loc = LocationManager.shared.location { body["lat"] = loc.coordinate.latitude; body["lng"] = loc.coordinate.longitude }
        SyncEngine.shared.enqueue("leads", body, label: String(localized: "Lead: \(name)"), photo: photo.flatMap { ImageTools.jpeg($0) }, photoKind: "door_photo", signature: signature)
        dismiss()
    }
}

struct LeadDetailView: View {
    let leadId: String
    @State private var lead: LeadDetail?
    @State private var service: Serviceability?
    @State private var chosen: Set<String> = []
    @State private var apptDate = Calendar.current.date(byAdding: .day, value: 2, to: .now)!
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        List {
            if let lead {
                Section {
                    LabeledContent("Customer", value: lead.customerName ?? "—")
                    LabeledContent("Phone", value: lead.phone ?? "—")
                    LabeledContent("Email", value: lead.email ?? "—")
                    LabeledContent("Address", value: lead.address)
                    HStack { Text("Status"); Spacer(); StatusBadge(status: lead.status) }
                    if lead.seatacValid == 0 { Label("Outside SeaTac: pending admin review", systemImage: "mappin.slash").foregroundStyle(.orange) }
                    if let r = lead.notServiceableReason { Text(r).foregroundStyle(.red) }
                }
                if !["order", "closed", "not_serviceable"].contains(lead.status) {
                    Section("Qualification") {
                        Button("Check serviceability") { Task { await checkService() } }
                        if let service, service.serviceable {
                            ForEach(service.items) { item in
                                Toggle(isOn: Binding(get: { chosen.contains(item.sku) }, set: { if $0 { _ = chosen.insert(item.sku) } else { _ = chosen.remove(item.sku) } })) {
                                    VStack(alignment: .leading) {
                                        Text(item.localizedName)
                                        Text("\(Fmt.money(item.promoPriceCents ?? item.monthlyPriceCents))/mo").font(.caption).foregroundStyle(.secondary)
                                        if let c = item.commissionCents { Text("Est. commission \(Fmt.money(c))").font(.caption2).foregroundStyle(.secondary) }
                                    }
                                }
                            }
                        }
                    }
                    Section("Appointment") {
                        DatePicker("Install / consult", selection: $apptDate, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                        Button("Book appointment") { book() }
                    }
                    Section {
                        Button { Task { await submitOrder() } } label: { if busy { ProgressView() } else { Text("Submit order").bold() } }
                            .disabled(chosen.isEmpty || busy)
                    } footer: {
                        Text("AT&T service charges are billed separately by AT&T. The customer gets an email to track the install in this app.")
                    }
                }
                if !lead.appointments.isEmpty {
                    Section("Appointments") {
                        ForEach(lead.appointments) { a in HStack { Text(Fmt.date(a.scheduledAt, time: true)); Spacer(); StatusBadge(status: a.status) } }
                    }
                }
                if let message { Section { Text(message) } }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Lead")
        .task { await load() }
    }

    private func load() async { lead = try? await APIClient.shared.get("leads/\(leadId)") }

    private func checkService() async {
        do {
            service = try await APIClient.shared.post("leads/\(leadId)/serviceability")
            if service?.serviceable == false { message = service?.reason; await load() }
        } catch { message = error.localizedDescription }
    }

    private func book() {
        let at = ISO8601DateFormatter().string(from: apptDate)
        let end = ISO8601DateFormatter().string(from: apptDate.addingTimeInterval(2 * 3600))
        SyncEngine.shared.enqueue("appointments", ["id": UUID().uuidString.lowercased(), "lead_id": leadId, "scheduled_at": at, "window_end": end, "kind": "install"], label: String(localized: "Appointment booked"))
        message = String(localized: "Appointment saved.")
        Task { try? await Task.sleep(for: .seconds(1)); await load() }
    }

    private func submitOrder() async {
        busy = true
        defer { busy = false }
        do {
            let at = ISO8601DateFormatter()
            let lang = Locale.current.language.languageCode?.identifier == "es" ? "es" : "en"
            try await APIClient.shared.send("POST", "orders", [
                "id": UUID().uuidString.lowercased(), "lead_id": leadId, "skus": Array(chosen), "customer_locale": lang,
                "install_window_start": at.string(from: apptDate), "install_window_end": at.string(from: apptDate.addingTimeInterval(2 * 3600)),
            ])
            message = String(localized: "Order submitted.")
            await load()
        } catch { message = error.localizedDescription }
    }
}
