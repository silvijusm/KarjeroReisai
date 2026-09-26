package lt.karjeroreisai.app.location

import lt.karjeroreisai.app.R
import lt.karjeroreisai.app.AppLanguage
import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.IBinder
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import lt.karjeroreisai.app.cloud.CloudSync
import lt.karjeroreisai.app.data.AppDatabase
import java.util.concurrent.Executors

class LocationTrackingService : Service() {

    private lateinit var db: AppDatabase
    private val fused by lazy { LocationServices.getFusedLocationProviderClient(this) }
    private var sessionId: Long = -1L
    private val io = Executors.newSingleThreadExecutor()
    private var lastRouteSync = 0L

    enum class AutoState { WAITING_FOR_A, ARMED_TO_B }

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location = result.lastLocation ?: return
            if (sessionId <= 0L) return

            val now = location.time.takeIf { it > 0L } ?: System.currentTimeMillis()

            db.addGpsPoint(
                sessionId = sessionId,
                timestamp = now,
                latitude = location.latitude,
                longitude = location.longitude,
                accuracy = location.accuracy,
                speed = location.speed
            )

            saveLatestLocation(location)
            processAutoCounting(location, now)

            // Cloud: live position (throttled inside) and the route every 5 minutes.
            val id = sessionId
            io.execute {
                runCatching { CloudSync.maybeSendLive(applicationContext, db, id, location) }
                if (System.currentTimeMillis() - lastRouteSync >= CloudSync.ROUTE_SYNC_INTERVAL_MS) {
                    lastRouteSync = System.currentTimeMillis()
                    runCatching { CloudSync.syncSession(applicationContext, db, id) }
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        db = AppDatabase(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        sessionId = if (intent?.hasExtra(EXTRA_SESSION_ID) == true) {
            intent.getLongExtra(EXTRA_SESSION_ID, -1L)
        } else {
            db.getActiveSession()?.id ?: -1L
        }

        if (sessionId <= 0L) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(AppLanguage.wrap(this).getString(R.string.app_name))
            .setContentText(AppLanguage.wrap(this).getString(R.string.gps_running))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        startLocationUpdates()
        return START_STICKY
    }

    private fun startLocationUpdates() {
        val fineGranted = ActivityCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        val coarseGranted = ActivityCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!fineGranted && !coarseGranted) {
            stopSelf()
            return
        }

        val request = LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            5_000L
        )
            .setMinUpdateIntervalMillis(2_000L)
            .setMinUpdateDistanceMeters(10f)
            .build()

        fused.removeLocationUpdates(callback)
        fused.requestLocationUpdates(request, callback, mainLooper)
    }

    private fun saveLatestLocation(location: Location) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putLong(KEY_LATEST_LAT_BITS, location.latitude.toBits())
            .putLong(KEY_LATEST_LON_BITS, location.longitude.toBits())
            .putLong(KEY_LATEST_TIME, System.currentTimeMillis())
            .putBoolean(KEY_HAS_LATEST, true)
            .apply()
    }

    private fun processAutoCounting(location: Location, now: Long) {
        if (location.accuracy > 80f) return

        var session = db.getSession(sessionId) ?: return
        if (!session.autoCount) return

        if (session.loadingLat == null || session.loadingLon == null) {
            db.setLoadingZone(sessionId, location.latitude, location.longitude)
            saveAutoState(AutoState.ARMED_TO_B)
            saveTripStartTime(now)
            return
        }

        if (session.unloadingLat == null || session.unloadingLon == null) return
        session = db.getSession(sessionId) ?: return

        val radius = session.zoneRadiusM.toFloat()
        val distanceA = distanceMeters(
            location.latitude,
            location.longitude,
            session.loadingLat!!,
            session.loadingLon!!
        )
        val distanceB = distanceMeters(
            location.latitude,
            location.longitude,
            session.unloadingLat!!,
            session.unloadingLon!!
        )

        val insideA = distanceA <= radius
        val insideB = distanceB <= radius

        when (loadAutoState()) {
            AutoState.WAITING_FOR_A -> {
                if (insideA && !insideB) {
                    saveTripStartTime(now)
                    saveAutoState(AutoState.ARMED_TO_B)
                }
            }

            AutoState.ARMED_TO_B -> {
                if (insideB && !insideA) {
                    val start = loadTripStartTime().takeIf { it > 0L } ?: session.startTime
                    val distanceKm = db.routeDistanceKm(sessionId, start, now)

                    db.addTrip(
                        sessionId = sessionId,
                        latitude = location.latitude,
                        longitude = location.longitude,
                        weight = session.defaultWeight,
                        source = "AUTO",
                        startTimestamp = start,
                        distanceKm = distanceKm,
                        durationMs = (now - start).coerceAtLeast(0L),
                        preventDuplicateWithinMs = 60_000L
                    )

                    val id = sessionId
                    io.execute { runCatching { CloudSync.syncSession(applicationContext, db, id) } }

                    // Persijungiame į laukimo būseną net jei DB atmetė dublį.
                    // Taip tame pačiame B taške po minutės nebus įrašytas antras reisas.
                    saveAutoState(AutoState.WAITING_FOR_A)
                    saveTripStartTime(0L)
                }
            }
        }
    }

    private fun distanceMeters(
        lat1: Double,
        lon1: Double,
        lat2: Double,
        lon2: Double
    ): Float {
        val out = FloatArray(1)
        Location.distanceBetween(lat1, lon1, lat2, lon2, out)
        return out[0]
    }

    private fun saveAutoState(state: AutoState) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(autoStateKey(sessionId), state.name)
            .apply()
    }

    private fun loadAutoState(): AutoState {
        val value = getSharedPreferences(PREFS, MODE_PRIVATE)
            .getString(autoStateKey(sessionId), AutoState.WAITING_FOR_A.name)

        return runCatching { AutoState.valueOf(value ?: AutoState.WAITING_FOR_A.name) }
            .getOrDefault(AutoState.WAITING_FOR_A)
    }

    private fun saveTripStartTime(time: Long) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putLong(tripStartKey(sessionId), time)
            .apply()
    }

    private fun loadTripStartTime(): Long =
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .getLong(tripStartKey(sessionId), 0L)

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            AppLanguage.wrap(this).getString(R.string.gps_tracking),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = AppLanguage.wrap(this@LocationTrackingService).getString(R.string.gps_running)
        }
        manager.createNotificationChannel(channel)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        fused.removeLocationUpdates(callback)
        io.shutdown()
        runCatching { io.awaitTermination(3, java.util.concurrent.TimeUnit.SECONDS) }
        if (::db.isInitialized) db.close()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_SESSION_ID = "extra_session_id"

        const val PREFS = "location_tracking"
        const val KEY_HAS_LATEST = "has_latest"
        const val KEY_LATEST_LAT_BITS = "latest_lat_bits"
        const val KEY_LATEST_LON_BITS = "latest_lon_bits"
        const val KEY_LATEST_TIME = "latest_time"

        private const val CHANNEL_ID = "karjero_reisai_tracking"
        private const val NOTIFICATION_ID = 1001

        fun autoStateKey(sessionId: Long): String = "auto_state_$sessionId"

        fun tripStartKey(sessionId: Long): String = "trip_start_$sessionId"
    }
}
