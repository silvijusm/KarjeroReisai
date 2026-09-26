package lt.karjeroreisai.app.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.util.UUID
import kotlin.math.roundToInt

data class SyncSnapshot(
    val localId: Long, val cloudId: String, val revision: Long, val lastGpsId: Long,
    val session: Map<String, Any?>, val trips: List<Pair<String, Map<String, Any?>>>,
    val routes: List<Pair<String, Map<String, Any?>>>
)

object RouteCodec {
    fun encode(points: List<Pair<Double, Double>>): String {
        var lat = 0; var lng = 0
        val out = StringBuilder()
        fun append(delta: Int) {
            var value = if (delta < 0) (delta shl 1).inv() else delta shl 1
            while (value >= 32) { out.append(((value and 31) or 32).plus(63).toChar()); value = value ushr 5 }
            out.append((value + 63).toChar())
        }
        points.forEach { (a, b) ->
            val nextLat = (a * 1e5).roundToInt(); val nextLng = (b * 1e5).roundToInt()
            append(nextLat - lat); append(nextLng - lng); lat = nextLat; lng = nextLng
        }
        return out.toString()
    }
    fun decode(encoded: String): List<Pair<Double, Double>> {
        var index = 0; var lat = 0; var lng = 0
        fun next(): Int {
            var result = 0; var shift = 0; var value: Int
            do {
                require(index < encoded.length && shift <= 30)
                value = encoded[index++].code - 63
                require(value in 0..63)
                result = result or ((value and 31) shl shift); shift += 5
            } while (value >= 32)
            return if (result and 1 != 0) (result ushr 1).inv() else result ushr 1
        }
        val points = mutableListOf<Pair<Double, Double>>()
        while (index < encoded.length) {
            lat += next(); lng += next()
            require(lat in -9000000..9000000 && lng in -18000000..18000000)
            points += lat / 1e5 to lng / 1e5
        }
        return points
    }
}

class SessionSyncStore(private val db: AppDatabase) {
    fun importLegacy(context: Context): Int {
        val identity = requireNotNull(db.identity)
        require(identity.canSync)
        val prefs = context.getSharedPreferences("sync_migration", Context.MODE_PRIVATE)
        val owner = prefs.getString("legacyOwner", null)
        require(owner == null || owner == identity.key)
        if (!context.getDatabasePath("karjero_reisai.db").exists()) return 0
        // Bind the legacy archive before copying. A crash may retry for the same
        // account, but never makes this archive available to a different account.
        check(prefs.edit().putString("legacyOwner", identity.key).commit())
        var imported = 0
        AppDatabase(context).use { source ->
            val sql = db.writableDatabase
            sql.beginTransaction()
            try {
                source.readableDatabase.rawQuery("SELECT * FROM work_sessions", null).use { sessions ->
                    while (sessions.moveToNext()) {
                        val oldId = sessions.getLong(sessions.getColumnIndexOrThrow("id"))
                        val cloudId = sessions.getString(sessions.getColumnIndexOrThrow("cloud_id"))
                        val exists = sql.rawQuery("SELECT id FROM work_sessions WHERE cloud_id=?", arrayOf(cloudId)).use { it.moveToFirst() }
                        if (exists) continue
                        val values = ContentValues()
                        android.database.DatabaseUtils.cursorRowToContentValues(sessions, values)
                        values.remove("id")
                        values.put("device_id", SyncIdentity.deviceId(context))
                        values.put("remote", 0); values.put("synced_revision", 0); values.put("synced_gps_id", 0)
                        if (values.getAsLong("end_time") == null) values.put("end_time", System.currentTimeMillis())
                        val id = sql.insertOrThrow("work_sessions", null, values)
                        for (table in listOf("trips", "gps_points")) {
                            source.readableDatabase.rawQuery("SELECT * FROM $table WHERE session_id=? ORDER BY id", arrayOf(oldId.toString())).use { rows ->
                                while (rows.moveToNext()) {
                                    val row = ContentValues()
                                    android.database.DatabaseUtils.cursorRowToContentValues(rows, row)
                                    row.remove("id"); row.put("session_id", id)
                                    sql.insertOrThrow(table, null, row)
                                }
                            }
                        }
                        imported++
                    }
                }
                sql.setTransactionSuccessful()
            } finally { sql.endTransaction() }
        }
        return imported
    }

    fun pendingCount(): Int = db.readableDatabase.rawQuery(
        "SELECT COUNT(*) FROM work_sessions WHERE remote=0 AND revision>synced_revision", null
    ).use { it.moveToFirst(); it.getInt(0) }

    fun nextSnapshot(excludedIds: Set<Long> = emptySet()): SyncSnapshot? {
        val sql = db.writableDatabase
        sql.beginTransaction()
        try {
            val excluded = if (excludedIds.isEmpty()) "" else " AND id NOT IN (${excludedIds.joinToString(",")})"
            val snapshot = sql.rawQuery("SELECT * FROM work_sessions WHERE remote=0 AND revision>synced_revision$excluded ORDER BY id LIMIT 1", null).use { c ->
                if (!c.moveToFirst()) return null
                val session = db.sessionFromCursor(c)
                val revision = c.getLong(c.getColumnIndexOrThrow("revision"))
                val cloudId = c.getString(c.getColumnIndexOrThrow("cloud_id"))
                val lastSent = c.getLong(c.getColumnIndexOrThrow("synced_gps_id"))
                val trips = mutableListOf<Pair<String, Map<String, Any?>>>()
                sql.rawQuery("SELECT * FROM trips WHERE session_id=? ORDER BY id", arrayOf(session.id.toString())).use { t ->
                    while (t.moveToNext()) {
                        val trip = db.tripFromCursor(t)
                        trips += trip.id.toString() to mapOf("tripNumber" to trip.tripNumber, "timestamp" to trip.timestamp,
                            "latitude" to trip.latitude, "longitude" to trip.longitude, "weight" to trip.weight,
                            "source" to trip.source, "startTimestamp" to trip.startTimestamp, "distanceKm" to trip.distanceKm,
                            "durationMs" to trip.durationMs, "deleted" to (t.getInt(t.getColumnIndexOrThrow("deleted")) == 1), "revision" to revision)
                    }
                }
                // Stable buckets by local point ID; rewrite the last partial bucket on retry.
                // This prevents duplicate points if the process dies after a remote commit.
                val allPoints = db.getGpsPoints(session.id).sortedBy { it.id }
                val routes = allPoints.filter { (it.id - 1) / 500 >= (lastSent.coerceAtLeast(1) - 1) / 500 }
                    .groupBy { (it.id - 1) / 500 }.map { (bucket, points) ->
                        bucket.toString() to mapOf<String, Any?>("encoding" to "polyline5",
                            "polyline" to RouteCodec.encode(points.map { it.latitude to it.longitude }),
                            "times" to points.map { it.timestamp }, "accuracies" to points.map { it.accuracy.toDouble() },
                            "speeds" to points.map { it.speed.toDouble() }, "pointCount" to points.size,
                            "firstPointId" to points.first().id, "lastPointId" to points.last().id, "revision" to revision)
                    }
                val visibleTrips = db.getTrips(session.id)
                val data = mapOf<String, Any?>("schemaVersion" to 1, "driverUid" to requireNotNull(db.identity).uid,
                    "deviceId" to c.getString(c.getColumnIndexOrThrow("device_id")), "revision" to revision, "completeRevision" to 0L,
                    "date" to session.date, "startedAt" to session.startTime, "endedAt" to session.endTime,
                    "loadingPlace" to session.loadingPlace, "unloadingPlace" to session.unloadingPlace,
                    "truck" to session.truck, "trailer" to session.trailer, "defaultWeight" to session.defaultWeight,
                    "loadingLat" to session.loadingLat, "loadingLon" to session.loadingLon,
                    "unloadingLat" to session.unloadingLat, "unloadingLon" to session.unloadingLon,
                    "zoneRadiusM" to session.zoneRadiusM, "autoCount" to session.autoCount,
                    "billingMode" to session.billingMode.name, "rate" to session.rate, "tripsCount" to visibleTrips.size,
                    "tonnes" to visibleTrips.sumOf { it.weight }, "km" to db.totalDistanceKm(session.id),
                    "earnings" to db.totalEarnings(session, visibleTrips))
                SyncSnapshot(session.id, cloudId, revision, allPoints.lastOrNull()?.id ?: 0L, data, trips, routes)
            }
            sql.setTransactionSuccessful()
            return snapshot
        } finally { sql.endTransaction() }
    }

    fun acknowledge(snapshot: SyncSnapshot) {
        // Never acknowledge edits made after the snapshot was taken.
        db.writableDatabase.execSQL("UPDATE work_sessions SET synced_revision=MAX(synced_revision,?), synced_gps_id=MAX(synced_gps_id,?) WHERE id=? AND cloud_id=?",
            arrayOf(snapshot.revision, snapshot.lastGpsId, snapshot.localId, snapshot.cloudId))
    }

    fun needsDownload(cloudId: String, revision: Long): Boolean = db.readableDatabase.rawQuery(
        "SELECT revision, remote FROM work_sessions WHERE cloud_id=?", arrayOf(cloudId)
    ).use { !it.moveToFirst() || (it.getInt(1) == 1 && it.getLong(0) < revision) }

    fun importRemote(cloudId: String, data: Map<String, Any?>, trips: List<Map<String, Any?>>, routes: List<Map<String, Any?>>) {
        val revision = (data["revision"] as Number).toLong()
        require(revision == (data["completeRevision"] as Number).toLong())
        if (!needsDownload(cloudId, revision)) return
        val values = sessionValues(data).apply {
            put("cloud_id", cloudId); put("device_id", data["deviceId"] as String)
            put("remote", 1); put("revision", revision); put("synced_revision", revision)
        }
        val sql = db.writableDatabase
        sql.beginTransaction()
        try {
            val existing = sql.rawQuery("SELECT id, remote FROM work_sessions WHERE cloud_id=?", arrayOf(cloudId)).use {
                if (it.moveToFirst()) { if (it.getInt(1) == 0) return; it.getLong(0) } else null
            }
            val id = if (existing == null) sql.insertOrThrow("work_sessions", null, values)
                else { sql.update("work_sessions", values, "id=?", arrayOf(existing.toString())); existing }
            sql.delete("trips", "session_id=?", arrayOf(id.toString()))
            sql.delete("gps_points", "session_id=?", arrayOf(id.toString()))
            trips.forEach { trip ->
                sql.insertOrThrow("trips", null, ContentValues().apply {
                    put("session_id", id)
                    for ((local, cloud) in tripFields) putValue(local, trip[cloud])
                })
            }
            routes.sortedBy { (it["firstPointId"] as Number).toLong() }.forEach { route ->
                val points = RouteCodec.decode(route["polyline"] as String)
                val times = route["times"] as List<*>
                val accuracy = route["accuracies"] as List<*>
                val speeds = route["speeds"] as List<*>
                require(points.size == times.size && times.size == accuracy.size && times.size == speeds.size)
                points.forEachIndexed { index, (lat, lng) ->
                    sql.insertOrThrow("gps_points", null, ContentValues().apply {
                        put("session_id", id); put("timestamp", (times[index] as Number).toLong())
                        put("latitude", lat); put("longitude", lng)
                        put("accuracy", (accuracy[index] as Number).toDouble()); put("speed", (speeds[index] as Number).toDouble())
                    })
                }
            }
            sql.setTransactionSuccessful()
        } finally { sql.endTransaction() }
    }

    companion object {
        private val sessionFields = mapOf("date" to "date", "start_time" to "startedAt", "end_time" to "endedAt",
            "loading_place" to "loadingPlace", "unloading_place" to "unloadingPlace", "truck" to "truck", "trailer" to "trailer",
            "default_weight" to "defaultWeight", "loading_lat" to "loadingLat", "loading_lon" to "loadingLon",
            "unloading_lat" to "unloadingLat", "unloading_lon" to "unloadingLon", "zone_radius_m" to "zoneRadiusM",
            "auto_count" to "autoCount", "billing_mode" to "billingMode", "rate" to "rate")
        private val tripFields = mapOf("trip_number" to "tripNumber", "timestamp" to "timestamp", "latitude" to "latitude",
            "longitude" to "longitude", "weight" to "weight", "source" to "source", "start_timestamp" to "startTimestamp",
            "distance_km" to "distanceKm", "duration_ms" to "durationMs", "deleted" to "deleted")
        private fun sessionValues(data: Map<String, Any?>) = ContentValues().apply {
            sessionFields.forEach { (local, cloud) -> putValue(local, data[cloud]) }
        }
        private fun ContentValues.putValue(key: String, value: Any?) {
            when (value) {
                null -> putNull(key)
                is Boolean -> put(key, if (value) 1 else 0)
                is Float, is Double -> put(key, (value as Number).toDouble())
                is Number -> put(key, value.toLong())
                is String -> put(key, value)
                else -> error("Unsupported field")
            }
        }
    }
}
