import PhotosUI
import StripePaymentSheet
import SwiftUI

struct CustomerHomeView: View {
    @Environment(AuthStore.self) private var auth
    @State private var tab = "orders"
    private let router = Router.shared

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { CustomerDashboardView() }
                .tabItem { Label("My order", systemImage: "shippingbox") }.tag("orders")
            NavigationStack { InvoicesView() }
                .tabItem { Label("Invoices", systemImage: "doc.text") }.tag("invoices")
            NavigationStack { FeedbackTabView() }
                .tabItem { Label("Feedback", systemImage: "star.bubble") }.tag("feedback")
        }
        .onChange(of: router.screen) { _, screen in
            switch screen {
            case "invoice": tab = "invoices"
            case "feedback": tab = "feedback"
            case "timeline": tab = "orders"
            default: break
            }
        }
    }
}

// MARK: Dashboard + timeline

struct CustomerDashboardView: View {
    @Environment(AuthStore.self) private var auth

    var body: some View {
        AsyncContent(load: { try await APIClient.shared.get("orders") as [OrderSummary] }) { orders, reload in
            List {
                if orders.isEmpty {
                    ContentUnavailableView("No orders yet", systemImage: "shippingbox", description: Text("Your order will appear here after your rep submits it."))
                }
                ForEach(orders) { order in
                    NavigationLink { OrderTimelineView(orderId: order.id) } label: { OrderCard(order: order) }
                }
            }
            .refreshable { await reload() }
        }
        .navigationTitle("My order")
        .toolbar {
            Menu {
                Button("Sign out", role: .destructive) { Task { await auth.signOut() } }
            } label: { Image(systemName: "person.crop.circle") }
            .accessibilityLabel(Text("Account"))
        }
    }
}

struct OrderCard: View {
    let order: OrderSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(order.bundle.items.map(\.name).joined(separator: " + ")).font(.headline)
                Spacer()
                StatusBadge(status: order.status)
            }
            if let address = order.address { Text(address).font(.subheadline).foregroundStyle(.secondary) }
            if let install = order.installScheduledAt {
                Label { Text("Install \(Fmt.date(install, time: true))") } icon: { Image(systemName: "calendar") }.font(.subheadline)
            }
            if let open = order.openInvoices, open > 0 {
                Label { Text("Invoice due") } icon: { Image(systemName: "exclamationmark.circle.fill") }
                    .font(.caption.bold()).foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 4)
    }
}

struct OrderTimelineView: View {
    let orderId: String

    var body: some View {
        AsyncContent(load: { try await APIClient.shared.get("orders/\(orderId)") as CustomerOrder }) { order, reload in
            List {
                Section {
                    ForEach(Array(order.timeline.enumerated()), id: \.element.id) { index, stage in
                        TimelineRow(stage: stage, isLast: index == order.timeline.count - 1)
                    }
                }
                Section("Your plan") {
                    ForEach(order.bundle.items, id: \.sku) { item in
                        HStack {
                            Text(item.name)
                            Spacer()
                            Text(Fmt.money(item.promoPriceCents ?? item.monthlyPriceCents)) + Text("/mo")
                        }
                    }
                    BillingNotice(text: order.billingNotice)
                }
            }
            .refreshable { await reload() }
        }
        .navigationTitle("Order status")
    }
}

struct TimelineRow: View {
    let stage: CustomerStage
    let isLast: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Image(systemName: icon).foregroundStyle(color).font(.title3)
                if !isLast { Rectangle().fill(color.opacity(0.4)).frame(width: 2).frame(minHeight: 24) }
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(stage.label).font(.headline)
                if let when = stage.scheduledFor { Text(Fmt.date(when, time: true)).font(.subheadline) }
                else if let done = stage.completedAt { Text(Fmt.date(done)).font(.subheadline).foregroundStyle(.secondary) }
                if let note = stage.note { Text(note).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(Text(LocalizedStringKey(stage.status)))
    }

    private var icon: String {
        switch stage.status {
        case "complete": "checkmark.circle.fill"
        case "delayed": "exclamationmark.triangle.fill"
        case "in_progress": "clock.fill"
        default: "circle"
        }
    }

    private var color: Color {
        switch stage.status {
        case "complete": .green
        case "delayed": .orange
        case "in_progress": .blue
        default: .secondary
        }
    }
}

// MARK: Invoices + payment

struct InvoicesView: View {
    var body: some View {
        AsyncContent(load: { try await APIClient.shared.get("invoices") as InvoiceList }) { list, reload in
            List {
                if list.invoices.isEmpty {
                    ContentUnavailableView("No invoices", systemImage: "doc.text", description: Text("Dealer invoices for setup or installation fees appear here."))
                }
                ForEach(list.invoices) { inv in
                    NavigationLink { InvoiceDetailView(invoiceId: inv.id) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack { Text(inv.description).font(.headline); Spacer(); StatusBadge(status: inv.status) }
                            Text("\(Fmt.money(inv.balanceCents)) due \(Fmt.day(inv.dueDate))").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                Section { BillingNotice(text: list.billingNotice) }
            }
            .refreshable { await reload() }
        }
        .navigationTitle("Invoices")
    }
}

struct InvoiceDetailView: View {
    let invoiceId: String
    @State private var invoice: Invoice?
    @State private var sheet: PaymentSheet?
    @State private var showSheet = false
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        List {
            if let inv = invoice {
                Section {
                    LabeledContent("Description", value: inv.description)
                    LabeledContent("Amount", value: Fmt.money(inv.amountCents))
                    LabeledContent("Paid", value: Fmt.money(inv.amountPaidCents))
                    LabeledContent("Balance", value: Fmt.money(inv.balanceCents)).bold()
                    LabeledContent("Due", value: Fmt.day(inv.dueDate))
                    LabeledContent("Terms") { Text(inv.paymentTermDays == 0 ? LocalizedStringKey("Due on receipt") : "Net \(inv.paymentTermDays)") }
                    HStack { Text("Status"); Spacer(); StatusBadge(status: inv.status) }
                }
                if inv.status != "paid" {
                    Section {
                        Button { Task { await pay("card") } } label: { Label("Pay with card", systemImage: "creditcard") }
                        Button { Task { await pay("ach") } } label: { Label("Pay from bank account (ACH)", systemImage: "building.columns") }
                    } footer: {
                        Text("Card and bank details are entered in the secure payment sheet and never stored by the dealer.")
                    }
                    .disabled(busy)
                }
                if let payments = inv.payments, !payments.isEmpty {
                    Section("Payments") {
                        ForEach(payments) { p in
                            HStack { Text(Fmt.date(p.createdAt)); Spacer(); Text(Fmt.money(p.amountCents)); StatusBadge(status: p.status) }
                        }
                    }
                }
                if let message { Section { Text(message) } }
                Section { BillingNotice(text: String(localized: "Your AT&T service charges are billed separately by AT&T.")) }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Invoice")
        .task { await load() }
        .refreshable { await load() }
        .paymentSheet(isPresented: $showSheet, paymentSheet: sheet ?? placeholderSheet) { result in
            switch result {
            case .completed: message = String(localized: "Payment submitted. Bank payments can take a few days to clear.")
            case .canceled: break
            case .failed(let error): message = error.localizedDescription
            }
            Task { await load() }
        }
    }

    // .paymentSheet needs a non-optional sheet; it's only presented once `sheet` is set.
    private var placeholderSheet: PaymentSheet { PaymentSheet(paymentIntentClientSecret: "", configuration: .init()) }

    private func load() async {
        invoice = try? await APIClient.shared.get("invoices/\(invoiceId)")
    }

    private func pay(_ method: String) async {
        busy = true
        defer { busy = false }
        do {
            let res: PayResponse = try await APIClient.shared.post("invoices/\(invoiceId)/pay", ["method": method])
            guard res.mode == "stripe", let secret = res.clientSecret, let key = res.publishableKey else {
                await load() // sandbox mode settles instantly
                return
            }
            STPAPIClient.shared.publishableKey = key
            var config = PaymentSheet.Configuration()
            config.merchantDisplayName = "DealerDoor"
            config.allowsDelayedPaymentMethods = true // ACH settles in days
            config.returnURL = "dealerdoor://stripe-redirect"
            sheet = PaymentSheet(paymentIntentClientSecret: secret, configuration: config)
            showSheet = true
        } catch {
            message = error.localizedDescription
        }
    }
}

// MARK: Feedback

struct FeedbackTabView: View {
    var body: some View {
        AsyncContent(load: { () async throws -> ([OrderSummary], [MyFeedback], FeedbackSummary) in
            async let orders: [OrderSummary] = APIClient.shared.get("orders")
            async let mine: [MyFeedback] = APIClient.shared.get("feedback/customer/mine")
            async let summary: FeedbackSummary = APIClient.shared.get("feedback/summary")
            return try await (orders, mine, summary)
        }) { data, reload in
            let (orders, mine, summary) = data
            let open = orders.filter { $0.activatedAt != nil && !mine.map(\.orderId).contains($0.id) }
            List {
                if let overall = summary.overall, summary.count > 0 {
                    Section {
                        Label { Text("Customers rate us \(overall, specifier: "%.1f") of 5 (\(summary.count) reviews)") } icon: { Image(systemName: "star.fill").foregroundStyle(.yellow) }
                    }
                }
                if let order = open.first {
                    Section("Rate your experience") { FeedbackForm(orderId: order.id) { await reload() } }
                } else if mine.isEmpty {
                    ContentUnavailableView("Feedback opens after activation", systemImage: "lock", description: Text("Once your service is active you can rate your rep and install."))
                }
                if !mine.isEmpty {
                    Section("Your feedback") {
                        ForEach(mine) { f in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack { Text("Sales \(f.salesRating) · Install \(f.installRating) · Clarity \(f.clarityRating) · Support \(f.supportRating)").font(.subheadline); Spacer(); StatusBadge(status: f.status) }
                                if let c = f.comment { Text(c).font(.footnote).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
            }
            .refreshable { await reload() }
        }
        .navigationTitle("Feedback")
    }
}

struct FeedbackForm: View {
    let orderId: String
    let onDone: () async -> Void
    @State private var sales = 0
    @State private var install = 0
    @State private var clarity = 0
    @State private var support = 0
    @State private var comment = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var photo: Data?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        StarRating(title: "Sales experience", value: $sales)
        StarRating(title: "Install timeliness", value: $install)
        StarRating(title: "Product clarity", value: $clarity)
        StarRating(title: "Customer support", value: $support)
        VStack(alignment: .leading) {
            TextField("Comments (optional)", text: $comment, axis: .vertical).lineLimit(3...8)
            Text("\(comment.count)/1000").font(.caption).foregroundStyle(comment.count > 1000 ? .red : .secondary)
        }
        PhotosPicker(selection: $photoItem, matching: .images) {
            Label(photo == nil ? LocalizedStringKey("Add a photo (optional)") : "Photo added", systemImage: photo == nil ? "photo" : "checkmark.circle.fill")
        }
        .onChange(of: photoItem) { _, item in
            Task {
                if let data = try? await item?.loadTransferable(type: Data.self), let img = UIImage(data: data) { photo = ImageTools.jpeg(img) }
            }
        }
        if let error { Text(error).foregroundStyle(.red) }
        Button {
            Task { await submit() }
        } label: { if busy { ProgressView() } else { Text("Submit feedback").bold() } }
        .disabled(busy || [sales, install, clarity, support].contains(0) || comment.count > 1000)
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            var body: [String: Any] = ["order_id": orderId, "sales_rating": sales, "install_rating": install, "clarity_rating": clarity, "support_rating": support]
            if !comment.isEmpty { body["comment"] = comment }
            if let photo { body["photo_key"] = try await APIClient.shared.upload(photo, kind: "feedback_photo") }
            try await APIClient.shared.send("POST", "feedback/customer", body)
            await onDone()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
