import SwiftUI
import UIKit

/// Loads async data with loading / error / retry states.
struct AsyncContent<T, Content: View>: View {
    let load: () async throws -> T
    @ViewBuilder let content: (T, @escaping () async -> Void) -> Content
    @State private var value: T?
    @State private var error: String?

    var body: some View {
        Group {
            if let value {
                content(value, reload)
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn't load", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { Task { await reload() } }
                }
            } else {
                ProgressView()
            }
        }
        .task { await reload() }
    }

    private func reload() async {
        do { value = try await load(); error = nil } catch { if value == nil { self.error = error.localizedDescription } }
    }
}

struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(LocalizedStringKey(status.replacingOccurrences(of: "_", with: " ")))
            .font(.caption.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case "paid", "complete", "activated", "approved": .green
        case "overdue", "rejected", "cancelled", "not_serviceable": .red
        case "partial", "delayed", "pending": .orange
        default: .blue
        }
    }
}

struct StarRating: View {
    let title: LocalizedStringKey
    @Binding var value: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
            HStack(spacing: 10) {
                ForEach(1...5, id: \.self) { i in
                    Button { value = i } label: {
                        Image(systemName: i <= value ? "star.fill" : "star").font(.title2).foregroundStyle(.yellow)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("\(i) stars"))
                    .accessibilityAddTraits(i == value ? .isSelected : [])
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// 1–5 picker used by the weekly pulse.
struct ScoreScale: View {
    let title: LocalizedStringKey
    @Binding var value: Int

    var body: some View {
        VStack(alignment: .leading) {
            Text(title)
            Picker(title, selection: $value) {
                ForEach(1...5, id: \.self) { Text("\($0)").tag($0) }
            }
            .pickerStyle(.segmented)
            HStack { Text("Poor"); Spacer(); Text("Great") }.font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct BillingNotice: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "info.circle").font(.footnote).foregroundStyle(.secondary)
    }
}

/// Finger signature captured as PNG for the consent record.
struct SignaturePad: View {
    @Binding var png: Data?
    @State private var lines: [[CGPoint]] = []

    var body: some View {
        VStack(alignment: .trailing) {
            drawing
                .frame(height: 140)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                .gesture(DragGesture(minimumDistance: 0).onChanged { g in
                    if lines.isEmpty || g.translation == .zero { lines.append([g.location]) } else { lines[lines.count - 1].append(g.location) }
                }.onEnded { _ in export() })
                .accessibilityLabel(Text("Signature area"))
            Button("Clear") { lines = []; png = nil }.font(.caption)
        }
    }

    private var drawing: some View {
        Canvas { ctx, _ in
            for line in lines {
                var path = Path()
                path.addLines(line)
                ctx.stroke(path, with: .color(.primary), lineWidth: 2.5)
            }
        }
    }

    private func export() {
        let renderer = ImageRenderer(content: drawing.frame(width: 340, height: 140).background(.white).environment(\.colorScheme, .light))
        renderer.scale = 2
        png = renderer.uiImage?.pngData()
    }
}

/// Camera capture for door/install photos.
struct CameraPicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.image = info[.originalImage] as? UIImage
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
