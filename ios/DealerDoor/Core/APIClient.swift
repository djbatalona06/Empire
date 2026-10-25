import Foundation

struct APIError: LocalizedError {
    let status: Int
    let code: String
    let message: String?
    let conflictId: String?

    var errorDescription: String? { message ?? code.replacingOccurrences(of: "_", with: " ") }
    /// The server refused an offline capture for a business rule (do-not-knock, geofence, consent).
    var isRuleViolation: Bool { [403, 409, 422].contains(status) }
}

extension Notification.Name {
    static let sessionExpired = Notification.Name("sessionExpired")
}

/// Thin JSON client for the Worker API. Refreshes the access token once on 401.
final class APIClient {
    static let shared = APIClient()

    let base: URL = {
        let s = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String
        return URL(string: s?.isEmpty == false ? s! : "http://localhost:8787")!
    }()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    var tokens: Tokens? {
        get { Keychain.load(Tokens.self, key: "tokens") }
        set { newValue.map { Keychain.save($0, key: "tokens") } ?? Keychain.delete(key: "tokens") }
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try decoder.decode(T.self, from: try await data("GET", path))
    }

    func post<T: Decodable>(_ path: String, _ body: [String: Any] = [:]) async throws -> T {
        try decoder.decode(T.self, from: try await data("POST", path, body: body))
    }

    @discardableResult
    func send(_ method: String, _ path: String, _ body: [String: Any] = [:]) async throws -> Data {
        try await data(method, path, body: body)
    }

    func data(_ method: String, _ path: String, body: [String: Any]? = nil, retried: Bool = false) async throws -> Data {
        var req = URLRequest(url: base.appendingPathComponent("v1").appendingPathComponent(path.split(separator: "?").first.map(String.init) ?? path))
        if let q = path.split(separator: "?").dropFirst().first {
            var comps = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
            comps.percentEncodedQuery = String(q)
            req.url = comps.url
        }
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = tokens?.accessToken { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body, method != "GET" { req.httpBody = try JSONSerialization.data(withJSONObject: body) }

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0

        if status == 401, !retried, !path.hasPrefix("auth/"), let refresh = tokens?.refreshToken {
            if await refreshTokens(refresh) { return try await self.data(method, path, body: body, retried: true) }
            tokens = nil
            await MainActor.run { NotificationCenter.default.post(name: .sessionExpired, object: nil) }
        }
        guard (200..<300).contains(status) else {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw APIError(status: status, code: obj?["error"] as? String ?? "http_\(status)", message: obj?["message"] as? String, conflictId: obj?["conflict_id"] as? String)
        }
        return data
    }

    private func refreshTokens(_ refresh: String) async -> Bool {
        guard let fresh: Tokens = try? await post("auth/refresh", ["refresh_token": refresh]) else { return false }
        tokens = fresh
        return true
    }

    /// Two-step private upload: get a signed URL, then PUT the bytes. Returns the R2 key.
    func upload(_ bytes: Data, kind: String, contentType: String = "image/jpeg") async throws -> String {
        let ticket: UploadTicket = try await post("uploads", ["kind": kind, "content_type": contentType])
        var req = URLRequest(url: URL(string: ticket.uploadUrl)!)
        req.httpMethod = "PUT"
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (_, response) = try await URLSession.shared.upload(for: req, from: bytes)
        guard (response as? HTTPURLResponse)?.statusCode == 201 else { throw APIError(status: 0, code: "upload_failed", message: nil, conflictId: nil) }
        return ticket.key
    }
}

/// Last-known-good copies of GET responses so the field app works without LTE.
enum OfflineCache {
    private static var dir: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0] }

    static func get<T: Codable>(_ path: String, as: T.Type = T.self) async throws -> T {
        let file = dir.appendingPathComponent(path.replacingOccurrences(of: "/", with: "_") + ".json")
        do {
            let value: T = try await APIClient.shared.get(path)
            if let data = try? JSONEncoder().encode(value) { try? data.write(to: file) }
            return value
        } catch let error as URLError {
            guard let data = try? Data(contentsOf: file), let cached = try? JSONDecoder().decode(T.self, from: data) else { throw error }
            return cached
        }
    }

    static func clear() {
        try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.forEach { try? FileManager.default.removeItem(at: $0) }
    }
}
