package com.dealerdoor.app

import com.dealerdoor.app.core.AppJson
import com.dealerdoor.app.core.Invoice
import com.dealerdoor.app.core.ServiceArea
import com.dealerdoor.app.core.toJson
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Test

class ModelsTest {
    @Test fun decodesSnakeCaseAndComputesBalance() {
        val inv = AppJson.decodeFromString<Invoice>(
            """{"id":"i1","description":"Setup","amount_cents":9900,"amount_paid_cents":4000,"payment_term_days":30,"due_date":"2026-11-10","status":"partial","extra":1}""",
        )
        assertEquals(5900, inv.balanceCents)
    }

    @Test fun flattensPolygonAndMultiPolygonRings() {
        val poly = AppJson.decodeFromString<ServiceArea>("""{"id":"a","name":"A","geojson":{"type":"Polygon","coordinates":[[[-122.3,47.4],[-122.2,47.4],[-122.2,47.5]]]}}""")
        assertEquals(listOf(47.4 to -122.3, 47.4 to -122.2, 47.5 to -122.2), poly.rings.single())
        val multi = AppJson.decodeFromString<ServiceArea>("""{"id":"b","name":"B","geojson":{"type":"MultiPolygon","coordinates":[[[[1,2],[3,4]]],[[[5,6],[7,8]]]]}}""")
        assertEquals(2, multi.rings.size)
    }

    @Test fun buildsRequestBodiesFromMaps() {
        val body = mapOf("id" to "x", "skus" to listOf("AIR"), "lat" to 47.4, "ok" to true, "none" to null).toJson().toString()
        assertEquals("""{"id":"x","skus":["AIR"],"lat":47.4,"ok":true,"none":null}""", body)
    }
}
