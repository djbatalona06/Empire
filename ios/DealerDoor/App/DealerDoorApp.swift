import StripePaymentSheet
import SwiftData
import SwiftUI

@main
struct DealerDoorApp: App {
    @UIApplicationDelegateAdaptor(PushManager.self) private var push
    @State private var auth = AuthStore()
    @Environment(\.scenePhase) private var scenePhase
    private let container: ModelContainer

    init() {
        container = try! ModelContainer(for: PendingOp.self)
        SyncEngine.shared.container = container
        _ = NetworkMonitor.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(auth)
                .modelContainer(container)
                .onOpenURL { url in
                    // Stripe bank-account redirects come back on our URL scheme too.
                    if StripeAPI.handleURLCallback(with: url) { return }
                    Task { await auth.handle(url: url) }
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { Task { await auth.handle(url: url) } }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await SyncEngine.shared.flush() } }
                }
        }
    }
}

struct RootView: View {
    @Environment(AuthStore.self) private var auth

    var body: some View {
        switch auth.state {
        case .loading:
            ProgressView()
        case .signedOut:
            LoginView()
        case .locked:
            LockView()
        case .signedIn(let me):
            if me.role == .customer { CustomerHomeView() } else { CoworkerHomeView() }
        }
    }
}
