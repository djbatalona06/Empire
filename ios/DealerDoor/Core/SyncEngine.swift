import Foundation
import Observation
import SwiftData

/// A field capture (lead, consent, check-in, appointment) waiting to reach the server.
/// Every capture goes through this queue, online or not, so there is one code path.
@Model
final class PendingOp {
    @Attribute(.unique) var id: UUID
    var path: String
    var body: Data
    var label: String
    var createdAt: Date
    var attempts: Int
    var lastError: String?
    /// Server refused it on a business rule (e.g. do-not-knock); kept for the rep to see, never retried.
    var conflicted: Bool
    @Attribute(.externalStorage) var photo: Data?
    var photoKind: String?
    @Attribute(.externalStorage) var signature: Data?

    init(path: String, body: Data, label: String, photo: Data?, photoKind: String?, signature: Data?) {
        id = UUID()
        self.path = path
        self.body = body
        self.label = label
        createdAt = .now
        attempts = 0
        conflicted = false
        self.photo = photo
        self.photoKind = photoKind
        self.signature = signature
    }
}

@MainActor @Observable
final class SyncEngine {
    static let shared = SyncEngine()

    var container: ModelContainer!
    private(set) var pendingCount = 0
    private(set) var conflictCount = 0
    private var flushing = false

    private var context: ModelContext { container.mainContext }

    /// Records carry a client UUID in `body["id"]`, so the API treats replays as no-ops.
    func enqueue(_ path: String, _ body: [String: Any], label: String, photo: Data? = nil, photoKind: String? = nil, signature: Data? = nil) {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        context.insert(PendingOp(path: path, body: data, label: label, photo: photo, photoKind: photoKind, signature: signature))
        try? context.save()
        refreshCounts()
        Task { await flush() }
    }

    func ops() -> [PendingOp] {
        (try? context.fetch(FetchDescriptor<PendingOp>(sortBy: [SortDescriptor(\.createdAt)]))) ?? []
    }

    func dismiss(_ op: PendingOp) {
        context.delete(op)
        try? context.save()
        refreshCounts()
    }

    /// Replays in capture order. Network/server errors stop the run; rule violations flag that item and move on.
    func flush() async {
        guard !flushing, APIClient.shared.tokens != nil else { return }
        flushing = true
        defer { flushing = false; refreshCounts() }

        for op in ops() where !op.conflicted {
            do {
                var body = (try JSONSerialization.jsonObject(with: op.body) as? [String: Any]) ?? [:]
                if let photo = op.photo, let kind = op.photoKind {
                    body["photo_key"] = try await APIClient.shared.upload(photo, kind: kind)
                    op.photo = nil
                }
                if let sig = op.signature {
                    body["signature_key"] = try await APIClient.shared.upload(sig, kind: "signature", contentType: "image/png")
                    op.signature = nil
                }
                // Persist uploaded keys so a retry doesn't re-upload.
                op.body = try JSONSerialization.data(withJSONObject: body)
                try await APIClient.shared.send("POST", op.path, body)
                context.delete(op)
            } catch let error as APIError where error.status >= 400 && error.status < 500 && error.status != 401 && error.status != 429 {
                op.conflicted = true
                op.lastError = error.errorDescription
            } catch {
                op.attempts += 1
                op.lastError = error.localizedDescription
                try? context.save()
                return
            }
            try? context.save()
        }
    }

    func refreshCounts() {
        let all = ops()
        pendingCount = all.filter { !$0.conflicted }.count
        conflictCount = all.filter(\.conflicted).count
    }
}
