import CoreLocation
import Foundation
import LocalAuthentication
import Network
import Observation
import UIKit
import UserNotifications

// MARK: Keychain (tokens never touch UserDefaults)

enum Keychain {
    static func save<T: Encodable>(_ value: T, key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        delete(key: key)
        SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrAccount: key, kSecValueData: data,
                    kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary, nil)
    }

    static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        var out: AnyObject?
        let status = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrAccount: key, kSecReturnData: true] as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    static func delete(key: String) {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrAccount: key] as CFDictionary)
    }
}

// MARK: Auth

@MainActor @Observable
final class AuthStore {
    enum State: Equatable { case loading, signedOut, locked, signedIn(Me) }

    var state: State = .loading
    var me: Me? { if case .signedIn(let m) = state { m } else { nil } }

    init() {
        // Returning users unlock with Face ID / passcode instead of a new magic link.
        state = APIClient.shared.tokens == nil ? .signedOut : .locked
        NotificationCenter.default.addObserver(forName: .sessionExpired, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.state = .signedOut }
        }
    }

    /// Password login returns tokens; otherwise the server emails a link (dev builds get the token back).
    func login(email: String, password: String?) async throws -> Bool {
        var body: [String: Any] = ["email": email]
        if let password, !password.isEmpty { body["password"] = password }
        let res: LoginResponse = try await APIClient.shared.post("auth/login", body)
        if let a = res.accessToken, let r = res.refreshToken { return try await finish(Tokens(accessToken: a, refreshToken: r)) }
        #if DEBUG
        if let dev = res.devToken { return try await verify(token: dev) }
        #endif
        return false
    }

    func verify(token: String) async throws -> Bool {
        try await finish(try await APIClient.shared.post("auth/verify", ["token": token]))
    }

    /// Handles https://<api>/auth/verify?token=… (universal link) and dealerdoor://auth?token=…
    func handle(url: URL) async {
        guard let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "token" })?.value else { return }
        _ = try? await verify(token: token)
    }

    private func finish(_ tokens: Tokens) async throws -> Bool {
        APIClient.shared.tokens = tokens
        try await loadMe()
        return true
    }

    func unlock() async {
        let ctx = LAContext()
        let ok = (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: String(localized: "Unlock DealerDoor"))) ?? false
        guard ok else { return }
        do { try await loadMe() } catch { state = .signedOut }
    }

    private func loadMe() async throws {
        let me: Me = try await APIClient.shared.get("me")
        state = .signedIn(me)
        // Keep server-side push/email language in sync with the device.
        let lang = Locale.current.language.languageCode?.identifier == "es" ? "es" : "en"
        if me.locale != lang { try? await APIClient.shared.send("PATCH", "me", ["locale": lang]) }
        PushManager.requestAuthorization()
    }

    func signOut() async {
        if let refresh = APIClient.shared.tokens?.refreshToken { try? await APIClient.shared.send("POST", "auth/logout", ["refresh_token": refresh]) }
        APIClient.shared.tokens = nil
        OfflineCache.clear()
        state = .signedOut
    }
}

// MARK: Push

/// Deep-link target from a tapped notification (payload "screen": timeline | invoice | feedback).
@MainActor @Observable
final class Router {
    static let shared = Router()
    var screen: String?
}

final class PushManager: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        Task { try? await APIClient.shared.send("POST", "devices", ["apns_token": hex, "env": env]) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let screen = response.notification.request.content.userInfo["screen"] as? String
        await MainActor.run { Router.shared.screen = screen }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

// MARK: Connectivity & location

@MainActor @Observable
final class NetworkMonitor {
    static let shared = NetworkMonitor()
    var isOnline = true
    private let monitor = NWPathMonitor()

    private init() {
        monitor.pathUpdateHandler = { path in
            Task { @MainActor in
                let online = path.status == .satisfied
                let cameBack = online && !NetworkMonitor.shared.isOnline
                NetworkMonitor.shared.isOnline = online
                if cameBack { await SyncEngine.shared.flush() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "network-monitor"))
    }
}

@MainActor @Observable
final class LocationManager: NSObject, CLLocationManagerDelegate {
    static let shared = LocationManager()
    var location: CLLocation?
    var authorized = false
    private let manager = CLLocationManager()

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func start() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in self.location = locations.last }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in self.authorized = status == .authorizedWhenInUse || status == .authorizedAlways }
    }

    /// Street address for the rep's current spot (on-device, no API key).
    func currentAddress() async -> String? {
        guard let location else { return nil }
        guard let p = try? await CLGeocoder().reverseGeocodeLocation(location).first else { return nil }
        return [[p.subThoroughfare, p.thoroughfare].compactMap { $0 }.joined(separator: " "), p.locality, [p.administrativeArea, p.postalCode].compactMap { $0 }.joined(separator: " ")]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

// MARK: Images

enum ImageTools {
    /// Downscale to keep uploads small on LTE.
    static func jpeg(_ image: UIImage, maxSide: CGFloat = 1600) -> Data? {
        let scale = min(1, maxSide / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }.jpegData(compressionQuality: 0.7)
    }
}
