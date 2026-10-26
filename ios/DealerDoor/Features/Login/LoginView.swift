import SwiftUI

struct LoginView: View {
    @Environment(AuthStore.self) private var auth
    @State private var email = ""
    @State private var password = ""
    @State private var usePassword = false
    @State private var busy = false
    @State private var message: LocalizedStringKey?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "house.and.flag.fill").font(.largeTitle).foregroundStyle(.tint).accessibilityHidden(true)
                        Text("Welcome to DealerDoor").font(.title2.bold())
                        Text("Track your install, pay dealer invoices, and share feedback. Team members sign in here too.").foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }
                Section {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login.email")
                    Toggle("Sign in with a password", isOn: $usePassword).accessibilityIdentifier("login.usePassword")
                    if usePassword {
                        SecureField("Password", text: $password).textContentType(.password)
                    }
                } footer: {
                    if let message { Text(message) }
                    if let errorText { Text(errorText).foregroundStyle(.red).accessibilityIdentifier("login.error") }
                }
                Button {
                    Task { await submit() }
                } label: {
                    HStack { Spacer(); if busy { ProgressView() } else { Text(usePassword ? LocalizedStringKey("Sign in") : "Email me a sign-in link").bold() }; Spacer() }
                }
                .disabled(busy || !email.contains("@"))
                .accessibilityIdentifier("login.submit")
            }
            .navigationTitle("Sign in")
        }
    }

    private func submit() async {
        busy = true
        errorText = nil
        defer { busy = false }
        do {
            let signedIn = try await auth.login(email: email.trimmingCharacters(in: .whitespaces).lowercased(), password: usePassword ? password : nil)
            if !signedIn { message = "Check your email and tap the link on this iPhone." }
        } catch {
            errorText = error.localizedDescription
        }
    }
}

struct LockView: View {
    @Environment(AuthStore.self) private var auth

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.fill").font(.system(size: 48)).foregroundStyle(.tint).accessibilityHidden(true)
            Text("DealerDoor is locked").font(.title2.bold())
            Button("Unlock") { Task { await auth.unlock() } }.buttonStyle(.borderedProminent)
            Button("Use a different account") { Task { await auth.signOut() } }
        }
        .task { await auth.unlock() }
    }
}
