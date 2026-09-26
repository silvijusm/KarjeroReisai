package lt.karjeroreisai.app.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.location.Location
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

enum class BillingMode {
    PER_TRIP,
    PER_TON,
    PER_DAY,
    PER_TON_KM
}

data class WorkSession(
    val id: Long,
    val date: String,
    val startTime: Long,
    val endTime: Long?,
    val loadingPlace: String,
    val unloadingPlace: String,
    val truck: String,
    val trailer: String,
    val defaultWeight: Double,
    val loadingLat: Double?,
    val loadingLon: Double?,
    val unloadingLat: Double?,
    val unloadingLon: Double?,
    val zoneRadiusM: Double,
    val autoCount: Boolean,
    val billingMode: BillingMode,
    val rate: Double
)

data class Trip(
    val id: Long,
    val sessionId: Long,
    val tripNumber: Int,
    val timestamp: Long,
    val latitude: Double?,
    val longitude: Double?,
    val weight: Double,
    val source: String,
    val startTimestamp: Long,
    val distanceKm: Double,
    val durationMs: Long
)

data class GpsPoint(
    val id: Long,
    val sessionId: Long,
    val timestamp: Long,
    val latitude: Double,
    val longitude: Double,
    val accuracy: Float,
    val speed: Float
)

class AppDatabase(context: Context, val identity: SyncIdentity? = null) :
    SQLiteOpenHelper(context, identity?.databaseName ?: "karjero_reisai.db", null, 4) {
    private val deviceId = SyncIdentity.deviceId(context)

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE work_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                start_time INTEGER NOT NULL,
                end_time INTEGER,
                loading_place TEXT NOT NULL,
                unloading_place TEXT NOT NULL,
                truck TEXT NOT NULL DEFAULT '',
                trailer TEXT NOT NULL DEFAULT '',
                default_weight REAL NOT NULL DEFAULT 0,
                loading_lat REAL,
                loading_lon REAL,
                unloading_lat REAL,
                unloading_lon REAL,
                zone_radius_m REAL NOT NULL DEFAULT 150,
                auto_count INTEGER NOT NULL DEFAULT 0,
                billing_mode TEXT NOT NULL DEFAULT 'PER_TRIP',
                rate REAL NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )

        db.execSQL(
            """
            CREATE TABLE trips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                trip_number INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                latitude REAL,
                longitude REAL,
                weight REAL NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'MANUAL',
                start_timestamp INTEGER NOT NULL DEFAULT 0,
                distance_km REAL NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(session_id) REFERENCES work_sessions(id)
            )
            """.trimIndent()
        )

        db.execSQL(
            """
            CREATE TABLE gps_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                accuracy REAL NOT NULL DEFAULT 0,
                speed REAL NOT NULL DEFAULT 0,
                FOREIGN KEY(session_id) REFERENCES work_sessions(id)
            )
            """.trimIndent()
        )

        db.execSQL("CREATE INDEX idx_trips_session ON trips(session_id)")
        db.execSQL("CREATE INDEX idx_gps_session ON gps_points(session_id)")
        db.execSQL("CREATE INDEX idx_gps_session_time ON gps_points(session_id, timestamp)")
        addSyncSchema(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE work_sessions ADD COLUMN loading_lat REAL")
            db.execSQL("ALTER TABLE work_sessions ADD COLUMN loading_lon REAL")
            db.execSQL("ALTER TABLE work_sessions ADD COLUMN unloading_lat REAL")
            db.execSQL("ALTER TABLE work_sessions ADD COLUMN unloading_lon REAL")
            db.execSQL("ALTER TABLE work_sessions ADD COLUMN zone_radius_m REAL NOT NULL DEFAULT 150")
            db.execSQL("ALTER TABLE work_sessions ADD COLUMN auto_count INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE trips ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL'")
        }
        if (oldVersion < 3) {
            db.execSQL("ALTER TABLE work_sessions ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'PER_TRIP'")
            db.execSQL("ALTER TABLE work_sessions ADD COLUMN rate REAL NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE trips ADD COLUMN start_timestamp INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE trips ADD COLUMN distance_km REAL NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE trips ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_gps_session_time ON gps_points(session_id, timestamp)")
        }
        if (oldVersion < 4) addSyncSchema(db)
    }

    private fun addSyncSchema(db: SQLiteDatabase) {
        db.execSQL("ALTER TABLE work_sessions ADD COLUMN cloud_id TEXT NOT NULL DEFAULT ''")
        db.execSQL("ALTER TABLE work_sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT ''")
        db.execSQL("ALTER TABLE work_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1")
        db.execSQL("ALTER TABLE work_sessions ADD COLUMN synced_revision INTEGER NOT NULL DEFAULT 0")
        db.execSQL("ALTER TABLE work_sessions ADD COLUMN synced_gps_id INTEGER NOT NULL DEFAULT 0")
        db.execSQL("ALTER TABLE work_sessions ADD COLUMN remote INTEGER NOT NULL DEFAULT 0")
        db.execSQL("ALTER TABLE trips ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
        db.rawQuery("SELECT id FROM work_sessions", null).use { cursor ->
            while (cursor.moveToNext()) db.execSQL("UPDATE work_sessions SET cloud_id=?, device_id=? WHERE id=?",
                arrayOf(UUID.randomUUID().toString(), deviceId, cursor.getLong(0)))
        }
        db.execSQL("CREATE UNIQUE INDEX idx_session_cloud ON work_sessions(cloud_id)")
        db.execSQL("""CREATE TRIGGER session_changed AFTER UPDATE OF end_time, loading_lat, loading_lon,
            unloading_lat, unloading_lon ON work_sessions WHEN NEW.remote=0
            BEGIN UPDATE work_sessions SET revision=revision+1 WHERE id=NEW.id; END""")
        for (table in listOf("trips", "gps_points")) {
            for (action in listOf("INSERT", "UPDATE", "DELETE")) {
                val record = if (action == "DELETE") "OLD" else "NEW"
                db.execSQL("""CREATE TRIGGER ${table}_${action.lowercase()} AFTER $action ON $table
                    BEGIN UPDATE work_sessions SET revision=revision+1
                    WHERE id=$record.session_id AND remote=0; END""")
            }
        }
    }

    fun startSession(
        loadingPlace: String,
        unloadingPlace: String,
        truck: String,
        trailer: String,
        defaultWeight: Double,
        autoCount: Boolean,
        zoneRadiusM: Double,
        billingMode: BillingMode,
        rate: Double
    ): Long {
        val now = System.currentTimeMillis()
        val date = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date(now))
        val values = ContentValues().apply {
            put("cloud_id", UUID.randomUUID().toString())
            put("device_id", deviceId)
            put("date", date)
            put("start_time", now)
            putNull("end_time")
            put("loading_place", loadingPlace.trim())
            put("unloading_place", unloadingPlace.trim())
            put("truck", truck.trim())
            put("trailer", trailer.trim())
            put("default_weight", defaultWeight)
            putNull("loading_lat")
            putNull("loading_lon")
            putNull("unloading_lat")
            putNull("unloading_lon")
            put("zone_radius_m", zoneRadiusM.coerceIn(50.0, 500.0))
            put("auto_count", if (autoCount) 1 else 0)
            put("billing_mode", billingMode.name)
            put("rate", rate.coerceAtLeast(0.0))
        }
        return writableDatabase.insertOrThrow("work_sessions", null, values)
    }

    fun endSession(sessionId: Long): WorkSession? {
        val values = ContentValues().apply {
            put("end_time", System.currentTimeMillis())
        }
        writableDatabase.update("work_sessions", values, "id=? AND remote=0 AND device_id=? AND end_time IS NULL", arrayOf(sessionId.toString(), deviceId))
        return getSession(sessionId)
    }

    fun setLoadingZone(sessionId: Long, lat: Double, lon: Double) {
        val values = ContentValues().apply {
            put("loading_lat", lat)
            put("loading_lon", lon)
        }
        writableDatabase.update("work_sessions", values, "id=? AND remote=0 AND device_id=? AND end_time IS NULL", arrayOf(sessionId.toString(), deviceId))
    }

    fun setUnloadingZone(sessionId: Long, lat: Double, lon: Double) {
        val values = ContentValues().apply {
            put("unloading_lat", lat)
            put("unloading_lon", lon)
        }
        writableDatabase.update("work_sessions", values, "id=? AND remote=0 AND device_id=? AND end_time IS NULL", arrayOf(sessionId.toString(), deviceId))
    }

    fun getActiveSession(): WorkSession? =
        querySession("SELECT * FROM work_sessions WHERE end_time IS NULL AND remote=0 AND device_id=? ORDER BY id DESC LIMIT 1", arrayOf(deviceId))

    fun getSession(sessionId: Long): WorkSession? =
        querySession("SELECT * FROM work_sessions WHERE id=? LIMIT 1", arrayOf(sessionId.toString()))

    private fun querySession(sql: String, args: Array<String>?): WorkSession? {
        readableDatabase.rawQuery(sql, args).use { c ->
            return if (c.moveToFirst()) sessionFromCursor(c) else null
        }
    }

    fun getSessions(limit: Int = 100): List<WorkSession> {
        val out = mutableListOf<WorkSession>()
        readableDatabase.rawQuery(
            "SELECT * FROM work_sessions ORDER BY id DESC LIMIT ?",
            arrayOf(limit.toString())
        ).use { c ->
            while (c.moveToNext()) out += sessionFromCursor(c)
        }
        return out
    }

    fun addTrip(
        sessionId: Long,
        latitude: Double?,
        longitude: Double?,
        weight: Double,
        source: String = "MANUAL",
        startTimestamp: Long,
        distanceKm: Double,
        durationMs: Long,
        preventDuplicateWithinMs: Long = 60_000L
    ): Long {
        writableDatabase.beginTransaction()
        try {
        if (!isEditable(sessionId)) return -1L
        val now = System.currentTimeMillis()

        readableDatabase.rawQuery(
            "SELECT timestamp FROM trips WHERE session_id=? AND deleted=0 ORDER BY timestamp DESC LIMIT 1",
            arrayOf(sessionId.toString())
        ).use { c ->
            if (c.moveToFirst()) {
                val last = c.getLong(0)
                if (now - last < preventDuplicateWithinMs) return -1L
            }
        }

        val nextNumber = getTripCount(sessionId) + 1
        val values = ContentValues().apply {
            put("session_id", sessionId)
            put("trip_number", nextNumber)
            put("timestamp", now)
            if (latitude == null) putNull("latitude") else put("latitude", latitude)
            if (longitude == null) putNull("longitude") else put("longitude", longitude)
            put("weight", weight)
            put("source", source)
            put("start_timestamp", startTimestamp)
            put("distance_km", distanceKm.coerceAtLeast(0.0))
            put("duration_ms", durationMs.coerceAtLeast(0L))
        }
        val inserted = writableDatabase.insertOrThrow("trips", null, values)
        writableDatabase.setTransactionSuccessful()
        return inserted
        } finally { writableDatabase.endTransaction() }
    }

    fun undoLastTrip(sessionId: Long) {
        if (!isEditable(sessionId)) return
        writableDatabase.execSQL(
            """
            UPDATE trips SET deleted=1
            WHERE id = (
                SELECT id FROM trips
                WHERE session_id=? AND deleted=0
                ORDER BY trip_number DESC
                LIMIT 1
            )
            """.trimIndent(),
            arrayOf(sessionId)
        )
    }

    fun getTripCount(sessionId: Long): Int {
        readableDatabase.rawQuery(
            "SELECT COUNT(*) FROM trips WHERE session_id=? AND deleted=0",
            arrayOf(sessionId.toString())
        ).use { c ->
            c.moveToFirst()
            return c.getInt(0)
        }
    }

    fun getLastTrip(sessionId: Long): Trip? {
        readableDatabase.rawQuery(
            "SELECT * FROM trips WHERE session_id=? AND deleted=0 ORDER BY trip_number DESC LIMIT 1",
            arrayOf(sessionId.toString())
        ).use { c ->
            return if (c.moveToFirst()) tripFromCursor(c) else null
        }
    }

    fun getTrips(sessionId: Long): List<Trip> {
        val out = mutableListOf<Trip>()
        readableDatabase.rawQuery(
            "SELECT * FROM trips WHERE session_id=? AND deleted=0 ORDER BY trip_number ASC",
            arrayOf(sessionId.toString())
        ).use { c ->
            while (c.moveToNext()) out += tripFromCursor(c)
        }
        return out
    }

    fun addGpsPoint(
        sessionId: Long,
        timestamp: Long,
        latitude: Double,
        longitude: Double,
        accuracy: Float,
        speed: Float
    ) {
        writableDatabase.beginTransaction()
        try {
        if (!isEditable(sessionId)) return
        val values = ContentValues().apply {
            put("session_id", sessionId)
            put("timestamp", timestamp)
            put("latitude", latitude)
            put("longitude", longitude)
            put("accuracy", accuracy)
            put("speed", speed)
        }
        writableDatabase.insertOrThrow("gps_points", null, values)
        writableDatabase.setTransactionSuccessful()
        } finally { writableDatabase.endTransaction() }
    }

    fun getGpsPoints(sessionId: Long): List<GpsPoint> {
        val out = mutableListOf<GpsPoint>()
        readableDatabase.rawQuery(
            "SELECT * FROM gps_points WHERE session_id=? ORDER BY timestamp ASC",
            arrayOf(sessionId.toString())
        ).use { c ->
            while (c.moveToNext()) {
                out += GpsPoint(
                    id = c.getLong(c.getColumnIndexOrThrow("id")),
                    sessionId = c.getLong(c.getColumnIndexOrThrow("session_id")),
                    timestamp = c.getLong(c.getColumnIndexOrThrow("timestamp")),
                    latitude = c.getDouble(c.getColumnIndexOrThrow("latitude")),
                    longitude = c.getDouble(c.getColumnIndexOrThrow("longitude")),
                    accuracy = c.getFloat(c.getColumnIndexOrThrow("accuracy")),
                    speed = c.getFloat(c.getColumnIndexOrThrow("speed"))
                )
            }
        }
        return out
    }

    fun routeDistanceKm(sessionId: Long, fromTimestamp: Long, toTimestamp: Long): Double {
        val points = mutableListOf<GpsPoint>()
        readableDatabase.rawQuery(
            """
            SELECT * FROM gps_points
            WHERE session_id=? AND timestamp>=? AND timestamp<=?
            ORDER BY timestamp ASC
            """.trimIndent(),
            arrayOf(sessionId.toString(), fromTimestamp.toString(), toTimestamp.toString())
        ).use { c ->
            while (c.moveToNext()) {
                val accuracy = c.getFloat(c.getColumnIndexOrThrow("accuracy"))
                if (accuracy <= 60f) {
                    points += GpsPoint(
                        id = c.getLong(c.getColumnIndexOrThrow("id")),
                        sessionId = c.getLong(c.getColumnIndexOrThrow("session_id")),
                        timestamp = c.getLong(c.getColumnIndexOrThrow("timestamp")),
                        latitude = c.getDouble(c.getColumnIndexOrThrow("latitude")),
                        longitude = c.getDouble(c.getColumnIndexOrThrow("longitude")),
                        accuracy = accuracy,
                        speed = c.getFloat(c.getColumnIndexOrThrow("speed"))
                    )
                }
            }
        }
        return calculateDistance(points)
    }

    fun totalDistanceKm(sessionId: Long): Double =
        calculateDistance(getGpsPoints(sessionId).filter { it.accuracy <= 60f })

    fun totalEarnings(session: WorkSession, trips: List<Trip>): Double =
        when (session.billingMode) {
            BillingMode.PER_TRIP -> trips.size * session.rate
            BillingMode.PER_TON -> trips.sumOf { it.weight } * session.rate
            BillingMode.PER_DAY -> if (trips.isNotEmpty()) session.rate else 0.0
            BillingMode.PER_TON_KM -> trips.sumOf { it.weight * it.distanceKm } * session.rate
        }

    private fun calculateDistance(points: List<GpsPoint>): Double {
        if (points.size < 2) return 0.0
        var meters = 0f
        for (i in 1 until points.size) {
            val a = points[i - 1]
            val b = points[i]
            val result = FloatArray(1)
            Location.distanceBetween(a.latitude, a.longitude, b.latitude, b.longitude, result)
            if (result[0] in 0f..2000f) meters += result[0]
        }
        return meters / 1000.0
    }

    internal fun tripFromCursor(c: android.database.Cursor): Trip =
        Trip(
            id = c.getLong(c.getColumnIndexOrThrow("id")),
            sessionId = c.getLong(c.getColumnIndexOrThrow("session_id")),
            tripNumber = c.getInt(c.getColumnIndexOrThrow("trip_number")),
            timestamp = c.getLong(c.getColumnIndexOrThrow("timestamp")),
            latitude = c.nullableDouble("latitude"),
            longitude = c.nullableDouble("longitude"),
            weight = c.getDouble(c.getColumnIndexOrThrow("weight")),
            source = c.getString(c.getColumnIndexOrThrow("source")),
            startTimestamp = c.getLong(c.getColumnIndexOrThrow("start_timestamp")),
            distanceKm = c.getDouble(c.getColumnIndexOrThrow("distance_km")),
            durationMs = c.getLong(c.getColumnIndexOrThrow("duration_ms"))
        )

    internal fun sessionFromCursor(c: android.database.Cursor): WorkSession =
        WorkSession(
            id = c.getLong(c.getColumnIndexOrThrow("id")),
            date = c.getString(c.getColumnIndexOrThrow("date")),
            startTime = c.getLong(c.getColumnIndexOrThrow("start_time")),
            endTime = if (c.isNull(c.getColumnIndexOrThrow("end_time"))) null
                else c.getLong(c.getColumnIndexOrThrow("end_time")),
            loadingPlace = c.getString(c.getColumnIndexOrThrow("loading_place")),
            unloadingPlace = c.getString(c.getColumnIndexOrThrow("unloading_place")),
            truck = c.getString(c.getColumnIndexOrThrow("truck")),
            trailer = c.getString(c.getColumnIndexOrThrow("trailer")),
            defaultWeight = c.getDouble(c.getColumnIndexOrThrow("default_weight")),
            loadingLat = c.nullableDouble("loading_lat"),
            loadingLon = c.nullableDouble("loading_lon"),
            unloadingLat = c.nullableDouble("unloading_lat"),
            unloadingLon = c.nullableDouble("unloading_lon"),
            zoneRadiusM = c.getDouble(c.getColumnIndexOrThrow("zone_radius_m")),
            autoCount = c.getInt(c.getColumnIndexOrThrow("auto_count")) == 1,
            billingMode = runCatching {
                BillingMode.valueOf(c.getString(c.getColumnIndexOrThrow("billing_mode")))
            }.getOrDefault(BillingMode.PER_TRIP),
            rate = c.getDouble(c.getColumnIndexOrThrow("rate"))
        )

    private fun android.database.Cursor.nullableDouble(name: String): Double? {
        val index = getColumnIndexOrThrow(name)
        return if (isNull(index)) null else getDouble(index)
    }

    private fun isEditable(id: Long): Boolean = readableDatabase.rawQuery(
        "SELECT id FROM work_sessions WHERE id=? AND remote=0 AND device_id=? AND end_time IS NULL",
        arrayOf(id.toString(), deviceId)
    ).use { it.moveToFirst() }
}
