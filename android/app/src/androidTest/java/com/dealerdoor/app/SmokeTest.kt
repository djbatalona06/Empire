package com.dealerdoor.app

import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.services.storage.TestStorage
import com.dealerdoor.app.core.UiTest
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Taps through the main screens against the local Worker (seed/dev.sql + e2e/tests/01-app-contract.spec.ts)
 * and saves a screenshot of each one. CI copies them off the emulator so every PR shows what the app looks like.
 */
@RunWith(AndroidJUnit4::class)
class SmokeTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val location: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

    private lateinit var scenario: ActivityScenario<MainActivity>

    @Before fun launch() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        scenario = ActivityScenario.launch(Intent(context, MainActivity::class.java).putExtra(UiTest.EXTRA, true))
    }

    @After fun close() = scenario.close()

    @Test fun loginNeedsAnEmail() {
        waitFor(hasTestTag("login.email"))
        snap("00-login")
        compose.onNode(hasTestTag("login.submit")).assertIsNotEnabled()
        compose.onNode(hasTestTag("login.email")).performTextInput("not-an-email")
        compose.onNode(hasTestTag("login.submit")).assertIsNotEnabled()
    }

    @Test fun coworkerTour() {
        signIn("rep1@dealerdoor.test")
        waitFor(hasText("Demo route"), 30_000)
        snap("01-coworker-route")

        if (exists(hasText("Weekly check-in: 3 quick questions"))) {
            tap(hasText("Weekly check-in: 3 quick questions"))
            waitFor(hasText("How fair was your workload this week?"))
            snap("02-coworker-pulse")
            tap(hasText("Later"))
        }

        val door = hasText("4800 S 188th St", substring = true) and hasClickAction()
        if (exists(door)) {
            compose.onAllNodes(door)[0].performClick()
            waitFor(hasText("Interested: capture lead"))
            snap("03-coworker-door")
            tap(hasText("Interested: capture lead"))
            waitFor(hasText("Customer agrees to calls and texts"))
            snap("04-coworker-lead-from-door")
            tap(hasContentDescription("Cancel"))
        }

        tap(hasText("Leads") and hasClickAction())
        waitFor(hasText("My leads"))
        snap("05-coworker-leads")
        tap(hasContentDescription("New lead"))
        waitFor(hasText("Customer agrees to calls and texts"))
        snap("06-coworker-new-lead")
        tap(hasContentDescription("Cancel"))

        tap(hasText("Me") and hasClickAction())
        waitFor(hasText("My scorecard"))
        snap("07-coworker-scorecard")
    }

    @Test fun customerTour() {
        signIn("customer@dealerdoor.test")
        val order = hasText("4800 S 188th St", substring = true) and hasClickAction()
        waitFor(order, 30_000) // run `npm run seed:customer` in e2e/ first so the customer has an order
        snap("10-customer-orders")
        compose.onAllNodes(order)[0].performClick()
        waitFor(hasText("Your plan"))
        snap("11-customer-timeline")
        tap(hasContentDescription("Back"))

        tap(hasText("Invoices") and hasClickAction())
        waitFor(hasText("Inside wiring"))
        snap("12-customer-invoices")
        compose.onAllNodes(hasText("Inside wiring"))[0].performClick()
        waitFor(hasText("Pay with card"))
        snap("13-customer-invoice-detail")
        tap(hasContentDescription("Back"))

        tap(hasText("Feedback") and hasClickAction())
        waitFor(hasText("Feedback opens after activation"))
        snap("14-customer-feedback")
    }

    // ---- Helpers ----

    private fun signIn(email: String) {
        waitFor(hasTestTag("login.email"))
        compose.onNode(hasTestTag("login.email")).performTextInput(email)
        compose.onNode(hasTestTag("login.submit")).performClick()
    }

    private fun exists(matcher: SemanticsMatcher, timeout: Long = 5_000): Boolean =
        runCatching { waitFor(matcher, timeout); true }.getOrDefault(false)

    private fun waitFor(matcher: SemanticsMatcher, timeout: Long = 15_000) {
        compose.waitUntil(timeout) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun tap(matcher: SemanticsMatcher) {
        waitFor(matcher)
        compose.onAllNodes(matcher)[0].performClick()
        compose.waitForIdle()
    }

    /** Full-screen capture (includes dialogs and bottom sheets), saved via the test storage service. */
    private fun snap(name: String) {
        compose.waitForIdle()
        Thread.sleep(500) // let images and map tiles settle
        val shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: return
        TestStorage().openOutputFile("screenshots/$name.png").use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
