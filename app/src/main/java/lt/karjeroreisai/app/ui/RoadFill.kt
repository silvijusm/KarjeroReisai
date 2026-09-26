package lt.karjeroreisai.app.ui

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.osmdroid.util.GeoPoint
import java.net.HttpURLConnection
import java.net.URL

/**
 * Where GPS points are missing (phone slept, tunnel, no signal) a route would be drawn as a
 * straight line across fields. This splits a route at such gaps and fills each gap with the
 * road between the two points (OSRM routing), drawn dashed as "approximate".
 */
object RoadFill {
    data class Result(val solid: List<List<GeoPoint>>, val estimated: List<List<GeoPoint>>)

    private const val GAP_M = 400.0
    private const val MAX_GAPS = 30
    private val cache = HashMap<String, List<GeoPoint>?>()

    suspend fun fill(lines: List<List<GeoPoint>>): Result {
        val solid = mutableListOf<List<GeoPoint>>()
        val estimated = mutableListOf<List<GeoPoint>>()
        var gaps = 0
        for (line in lines) {
            var current = mutableListOf<GeoPoint>()
            for (p in line) {
                val prev = current.lastOrNull()
                if (prev != null && prev.distanceToAsDouble(p) > GAP_M) {
                    if (current.size > 1) solid += current
                    val road = if (gaps++ < MAX_GAPS) road(prev, p) else null
                    estimated += road ?: listOf(prev, p)
                    current = mutableListOf()
                }
                current += p
            }
            if (current.size > 1) solid += current
        }
        return Result(solid, estimated)
    }

    private suspend fun road(a: GeoPoint, b: GeoPoint): List<GeoPoint>? {
        val key = String.format(java.util.Locale.US, "%.5f,%.5f;%.5f,%.5f", a.longitude, a.latitude, b.longitude, b.latitude)
        if (cache.containsKey(key)) return cache[key]
        val result = withContext(Dispatchers.IO) {
            runCatching {
                val conn = URL("https://router.project-osrm.org/route/v1/driving/$key?overview=full&geometries=geojson")
                    .openConnection() as HttpURLConnection
                conn.connectTimeout = 5_000
                conn.readTimeout = 8_000
                conn.setRequestProperty("User-Agent", "KarjeroReisai-Android")
                try {
                    if (conn.responseCode != 200) return@runCatching null
                    val json = JSONObject(conn.inputStream.bufferedReader().readText())
                    val route = json.getJSONArray("routes").optJSONObject(0) ?: return@runCatching null
                    val straight = a.distanceToAsDouble(b)
                    // A detour much longer than the gap means the road guess is not credible.
                    if (route.optDouble("distance", 0.0) > straight * 3 + 2_000) return@runCatching null
                    val coords = route.getJSONObject("geometry").getJSONArray("coordinates")
                    List(coords.length()) { i -> coords.getJSONArray(i).let { GeoPoint(it.getDouble(1), it.getDouble(0)) } }
                        .let { listOf(a) + it + listOf(b) }
                } finally {
                    conn.disconnect()
                }
            }.getOrNull()
        }
        cache[key] = result
        return result
    }
}
