package com.dealerdoor.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.fragment.app.FragmentActivity
import com.dealerdoor.app.core.Auth
import com.dealerdoor.app.core.UiTest
import com.dealerdoor.app.ui.DealerDoorTheme
import com.dealerdoor.app.ui.RootScreen

// FragmentActivity (a ComponentActivity) so the fingerprint / screen-lock prompt can attach to it.
class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildConfig.DEBUG && intent.getBooleanExtra(UiTest.EXTRA, false)) Auth.resetForUiTest()
        intent?.data?.let(Auth::handle)
        enableEdgeToEdge()
        setContent { DealerDoorTheme { RootScreen() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let(Auth::handle)
    }
}
