package com.dealerdoor.app

import android.app.Application
import com.dealerdoor.app.core.Auth
import com.dealerdoor.app.core.NetworkMonitor
import com.dealerdoor.app.core.OfflineCache
import com.dealerdoor.app.core.SyncEngine
import com.dealerdoor.app.core.TokenStore
import org.osmdroid.config.Configuration

class DealerDoorApp : Application() {
    override fun onCreate() {
        super.onCreate()
        TokenStore.init(this)
        OfflineCache.dir = cacheDir
        SyncEngine.init(filesDir)
        Auth.init()
        NetworkMonitor.start(this)
        // OpenStreetMap tiles ask every app to identify itself.
        Configuration.getInstance().userAgentValue = "DealerDoor/${BuildConfig.VERSION_NAME} (${BuildConfig.APPLICATION_ID})"
    }
}
