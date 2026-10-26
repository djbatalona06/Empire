import XCTest

/// Taps through the main screens against the local Worker (seed/dev.sql + e2e/tests/01-app-contract.spec.ts)
/// and attaches a screenshot of each one. CI exports them so every PR shows what the app looks like.
@MainActor
final class SmokeTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-uitest", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
    }

    func testLoginNeedsAnEmail() {
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 20))
        snap("00-login")
        XCTAssertFalse(app.buttons["login.submit"].isEnabled)
        email.tap()
        email.typeText("not-an-email")
        XCTAssertFalse(app.buttons["login.submit"].isEnabled)
    }

    func testCoworkerTour() {
        signIn("rep1@dealerdoor.test")

        XCTAssertTrue(app.tabBars.buttons["Route"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Demo route"].waitForExistence(timeout: 20), "seeded route r1 should load")
        snap("01-coworker-route")

        let pulse = app.buttons["Weekly check-in: 3 quick questions"]
        if pulse.waitForExistence(timeout: 5) {
            pulse.tap()
            XCTAssertTrue(app.navigationBars["Weekly check-in"].waitForExistence(timeout: 10))
            snap("02-coworker-pulse")
            app.buttons["Later"].tap()
        }

        let door = app.buttons["4800 S 188th St, SeaTac, WA 98188"]
        if door.waitForExistence(timeout: 5) {
            door.tap()
            XCTAssertTrue(app.navigationBars["Door"].waitForExistence(timeout: 10))
            snap("03-coworker-door")
            app.buttons["Interested: capture lead"].tap()
            XCTAssertTrue(app.navigationBars["New lead"].waitForExistence(timeout: 10))
            snap("04-coworker-lead-from-door")
            app.buttons["Cancel"].tap()
        }

        app.tabBars.buttons["Leads"].tap()
        XCTAssertTrue(app.navigationBars["Leads"].waitForExistence(timeout: 10))
        snap("05-coworker-leads")
        app.buttons["New lead"].tap()
        XCTAssertTrue(app.navigationBars["New lead"].waitForExistence(timeout: 10))
        snap("06-coworker-new-lead")
        app.buttons["Cancel"].tap()

        app.tabBars.buttons["Me"].tap()
        snap("07-coworker-scorecard")
    }

    func testCustomerTour() {
        signIn("customer@dealerdoor.test")

        XCTAssertTrue(app.tabBars.buttons["My order"].waitForExistence(timeout: 30))
        let order = app.cells.firstMatch
        XCTAssertTrue(order.waitForExistence(timeout: 20), "run e2e seed:customer first so the customer has an order")
        snap("10-customer-orders")
        order.tap()
        XCTAssertTrue(app.navigationBars["Order status"].waitForExistence(timeout: 10))
        snap("11-customer-timeline")

        app.tabBars.buttons["Invoices"].tap()
        XCTAssertTrue(app.navigationBars["Invoices"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Inside wiring"].waitForExistence(timeout: 20))
        snap("12-customer-invoices")
        app.staticTexts["Inside wiring"].tap()
        XCTAssertTrue(app.buttons["Pay with card"].waitForExistence(timeout: 15))
        snap("13-customer-invoice-detail")

        app.tabBars.buttons["Feedback"].tap()
        XCTAssertTrue(app.navigationBars["Feedback"].waitForExistence(timeout: 10))
        snap("14-customer-feedback")
    }

    // MARK: Helpers

    private func signIn(_ email: String) {
        let field = app.textFields["login.email"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        field.typeText(email)
        app.buttons["login.submit"].tap()
        if app.staticTexts["login.error"].waitForExistence(timeout: 3) {
            XCTFail("Sign-in failed: \(app.staticTexts["login.error"].label). Is the local Worker running on :8787?")
        }
    }

    private func snap(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
