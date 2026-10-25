import Charts
import SwiftUI

/// Weekly 3-question pulse. Anonymous unless the coworker opts in to a named follow-up.
struct PulseView: View {
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var workload = 3
    @State private var safety = 3
    @State private var support = 3
    @State private var anonymous = true
    @State private var followup = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ScoreScale(title: "How fair was your workload this week?", value: $workload)
                    ScoreScale(title: "How safe and comfortable did you feel in the field?", value: $safety)
                    ScoreScale(title: "How supported did you feel by your lead?", value: $support)
                }
                Section {
                    Toggle("Answer anonymously", isOn: $anonymous)
                        .onChange(of: anonymous) { _, on in if on { followup = false } }
                    if !anonymous { Toggle("I'd like a follow-up conversation", isOn: $followup) }
                } footer: {
                    Text("Anonymous answers are never linked to your name. Your crew's results only appear once at least 3 people answer.")
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Weekly check-in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Later") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Submit") { Task { await submit() } } }
            }
        }
    }

    private func submit() async {
        do {
            try await APIClient.shared.send("POST", "pulse", ["workload_score": workload, "safety_score": safety, "support_score": support, "anonymous": anonymous, "followup_requested": followup])
            onDone()
            dismiss()
        } catch let e as APIError where e.code == "already_submitted_this_week" {
            onDone()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ScorecardView: View {
    @Environment(AuthStore.self) private var auth
    @State private var giveKudos = false

    var body: some View {
        AsyncContent(load: { () async throws -> (Scorecard, CrewScorecard) in
            async let me: Scorecard = APIClient.shared.get("scorecards/me")
            async let crew: CrewScorecard = APIClient.shared.get("scorecards/crew")
            return try await (me, crew)
        }) { data, reload in
            let (mine, crew) = data
            List {
                if let s = mine.sales {
                    Section("Last 90 days") {
                        HStack {
                            stat("Leads", s.leads)
                            stat("Appts", s.appointments)
                            stat("Orders", s.orders)
                            stat("Active", s.activations)
                        }
                    }
                }
                Section("My check-in trend") { TrendChart(points: mine.trend) }
                Section("Crew average") {
                    if crew.trend.isEmpty { Text("Shown once at least 3 crew members answer.").foregroundStyle(.secondary) } else { TrendChart(points: crew.trend) }
                }
                Section("Kudos") {
                    if mine.kudos.isEmpty { Text("No kudos yet.").foregroundStyle(.secondary) }
                    ForEach(mine.kudos) { k in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(k.message)
                            Text("\(k.fromName ?? "—") · \(Fmt.date(k.createdAt))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .refreshable { await reload() }
        }
        .navigationTitle("My scorecard")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { Button { giveKudos = true } label: { Label("Give kudos", systemImage: "hands.clap") } }
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button("Sign out", role: .destructive) { Task { await auth.signOut() } }
                } label: { Image(systemName: "person.crop.circle") }
                .accessibilityLabel(Text("Account"))
            }
        }
        .sheet(isPresented: $giveKudos) { KudosSheet() }
    }

    private func stat(_ label: LocalizedStringKey, _ value: Int) -> some View {
        VStack { Text("\(value)").font(.title2.bold()); Text(label).font(.caption).foregroundStyle(.secondary) }.frame(maxWidth: .infinity)
    }
}

struct TrendChart: View {
    let points: [TrendPoint]

    private struct Row: Identifiable { let week: String; let metric: String; let value: Double; var id: String { week + metric } }

    private var rows: [Row] {
        points.flatMap { p in
            [(String(localized: "Workload"), p.workload), (String(localized: "Safety"), p.safety), (String(localized: "Support"), p.support)]
                .compactMap { name, v in v.map { Row(week: p.isoWeek, metric: name, value: $0) } }
        }
    }

    var body: some View {
        if points.isEmpty {
            Text("Answer the weekly check-in to see your trend.").foregroundStyle(.secondary)
        } else {
            Chart(rows) { r in
                LineMark(x: .value("Week", r.week), y: .value("Score", r.value)).foregroundStyle(by: .value("Metric", r.metric))
                PointMark(x: .value("Week", r.week), y: .value("Score", r.value)).foregroundStyle(by: .value("Metric", r.metric))
            }
            .chartYScale(domain: 1.0...5.0)
            .frame(height: 180)
            .accessibilityLabel(Text("Check-in scores by week"))
        }
    }
}

/// Peer kudos must point at a route or order (spec 4.6).
struct KudosSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var coworkers: [Coworker] = []
    @State private var routes: [CanvassRoute] = []
    @State private var to: Coworker?
    @State private var routeId: String?
    @State private var orderId = ""
    @State private var message = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Picker("Coworker", selection: $to) {
                    Text("Choose…").tag(Coworker?.none)
                    ForEach(coworkers) { Text($0.displayName ?? "—").tag(Optional($0)) }
                }
                Section("For") {
                    Picker("Route", selection: $routeId) {
                        Text("None").tag(String?.none)
                        ForEach(routes) { Text("\($0.name) · \($0.routeDate)").tag(Optional($0.id)) }
                    }
                    TextField("or order ID", text: $orderId).textInputAutocapitalization(.never)
                }
                Section {
                    TextField("Message", text: $message, axis: .vertical).lineLimit(2...5)
                    Text("\(message.count)/280").font(.caption).foregroundStyle(message.count > 280 ? .red : .secondary)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Give kudos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { Task { await send() } }.disabled(to == nil || message.isEmpty || message.count > 280 || (routeId == nil && orderId.isEmpty))
                }
            }
            .task {
                coworkers = (try? await APIClient.shared.get("coworkers")) ?? []
                routes = (try? await OfflineCache.get("routes/mine")) ?? []
            }
        }
    }

    private func send() async {
        guard let to else { return }
        var body: [String: Any] = ["to_user_id": to.id, "message": message]
        if let routeId { body["route_id"] = routeId }
        if !orderId.isEmpty { body["order_id"] = orderId.trimmingCharacters(in: .whitespaces) }
        do {
            try await APIClient.shared.send("POST", "kudos", body)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
