package lt.karjeroreisai.app.location

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
import lt.karjeroreisai.app.data.AppDatabase

class LocationTrackingService : Service() {

    private lateinit var db: AppDatabase
    private val fused by lazy { LocationServices.getFusedLocationProviderClient(this) }
    private var sessionId: Long = -1L

    enum class AutoState { WAITING_FOR_A, ARMED_TO_B }

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location = result.lastLocation ?: return
            if (sessionId <= 0L) return

            val now = location.time.takeIf { it > 0 } ?: System.currentTimeMillis()

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
        }
    }

    override fun onCreate() {
        super.onCreate()
        db = AppDatabase(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        sessionId = intent?.getLongExtra(EXTRA_SESSION_ID, -1L)
            ?: db.getActiveSession()?.id
            ?: -1L

        if (sessionId <= 0L) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Karjero reisai")
            .setContentText("GPS ir reisų apskaita veikia")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= 29) {
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
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        val coarseGranted = ActivityCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_COARSE_LOCATION
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
            location.latitude, location.longitude,
            session.loadingLat!!, session.loadingLon!!
        )
        val distanceB = distanceMeters(
            location.latitude, location.longitude,
            session.unloadingLat!!, session.unloadingLon!!
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

                    val inserted = db.addTrip(
                        sessionId = sessionId,
                        latitude = location.latitude,
                        longitude = location.longitude,
                        weight = session.defaultWeight,
                        source = "AUTO",
                        startTimestamp = start,
                        distanceKm = distanceKm,
                        durationMs = now - start,
                        preventDuplicateWithinMs = 60_000L
                    )

                    // Net jei DB dėl dubliavimo atmetė įrašą, būnant B nepaliekame ARMED būsenos.
                    // Tai neleidžia po 60 s netyčia suskaičiuoti dar vieno reiso tame pač
