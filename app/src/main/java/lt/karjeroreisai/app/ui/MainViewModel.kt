package lt.karjeroreisai.app.ui

import lt.karjeroreisai.app.R
import lt.karjeroreisai.app.AppLanguage
import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import lt.karjeroreisai.app.data.AppDatabase
import lt.karjeroreisai.app.data.BillingMode
import lt.karjeroreisai.app.data.GpsPoint
import lt.karjeroreisai.app.data.Trip
import lt.karjeroreisai.app.data.WorkSession
import lt.karjeroreisai.app.location.LocationTrackingService

data class DashboardState(
    val session: WorkSession? = null,
    val trips: Int = 0,
    val distanceKm: Double = 0.0,
    val totalTons: Double = 0.0,
    val earnings: Double = 0.0,
    val now: Long = System.currentTimeMillis(),
    val busy: Boolean = false,
    val statusMessage: String? = null
)

data class SessionSummary(
    val session: WorkSession,
    val trips: List<Trip>,
    val totalDistanceKm: Double,
    val totalTons: Double,
    val earnings: Double
)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val db = AppDatabase(app)

    private val _dashboard = MutableStateFlow(DashboardState())
    val dashboard: StateFlow<DashboardState> = _dashboard.asStateFlow()

    private val _history = MutableStateFlow<List<WorkSession>>(emptyList())
    val history: StateFlow<List<WorkSession>> = _history.asStateFlow()

    private val _lastEndedId = MutableStateFlow<Long?>(null)
    val lastEndedId: StateFlow<Long?> = _lastEndedId.asStateFlow()

    fun refresh() {
        viewModelScope.launch {
            val oldMessage = _dashboard.value.statusMessage
            val data = withContext(Dispatchers.IO) {
                val session = db.getActiveSession()
                if (session == null) {
                    DashboardState(now = System.currentTimeMillis(), statusMessage = oldMessage)
                } else {
                    val trips = db.getTrips(session.id)
                    val km = db.totalDistanceKm(session.id)
                    DashboardState(
                        session = session,
                        trips = trips.size,
                        distanceKm = km,
                        totalTons = trips.sumOf { it.weight },
                        earnings = db.totalEarnings(session, trips),
                        now = System.currentTimeMillis(),
                        statusMessage = oldMessage
                    )
                }
            }
            _dashboard.value = data
        }
    }

    fun clearStatusMessage() {
        _dashboard.value = _dashboard.value.copy(statusMessage = null)
    }

    fun loadHistory() {
        viewModelScope.launch {
            _history.value = withContext(Dispatchers.IO) { db.getSessions() }
        }
    }

    fun startSession(
        loading: String,
        unloading: String,
        truck: String,
        trailer: String,
        weight: Double,
        autoCount: Boolean,
        zoneRadiusM: Double,
        billingMode: BillingMode,
        rate: Double,
        onStarted: (Long) -> Unit
    ) {
        if (loading.isBlank() || unloading.isBlank()) return

        viewModelScope.launch {
            _dashboard.value = _dashboard.value.copy(busy = true)
            val id = withContext(Dispatchers.IO) {
                db.startSession(
                    loadingPlace = loading,
                    unloadingPlace = unloading,
                    truck = truck,
                    trailer = trailer,
                    defaultWeight = weight,
                    autoCount = autoCount,
                    zoneRadiusM = zoneRadiusM,
                    billingMode = billingMode,
                    rate = rate
                )
            }
            refresh()
            onStarted(id)
        }
    }

    fun addTripManual() {
        val session = _dashboard.value.session ?: return
        viewModelScope.launch {
            val inserted = withContext(Dispatchers.IO) {
                val current = latestLocation()
                val now = System.currentTimeMillis()
                val last = db.getLastTrip(session.id)
                val start = last?.timestamp ?: session.startTime
                val distance = db.routeDistanceKm(session.id, start, now)

                db.addTrip(
                    sessionId = session.id,
                    latitude = current?.first,
                    longitude = current?.second,
                    weight = session.defaultWeight,
                    source = "MANUAL",
                    startTimestamp = start,
                    distanceKm = distance,
                    durationMs = now - start,
                    preventDuplicateWithinMs = 60_000L
                )
            }

            _dashboard.value = _dashboard.value.copy(
                statusMessage = if (inserted > 0L)
                    AppLanguage.wrap(getApplication()).getString(R.string.trip_added)
                else
                    AppLanguage.wrap(getApplication()).getString(R.string.trip_duplicate)
            )
            refresh()
        }
    }

    fun setUnloadingZoneHereAndCountFirstTrip() {
        val session = _dashboard.value.session ?: return

        viewModelScope.launch {
            val message = withContext(Dispatchers.IO) {
                val current = latestLocation()
                    ?: return@withContext AppLanguage.wrap(getApplication()).getString(R.string.gps_wait)

                val now = System.currentTimeMillis()
                db.setUnloadingZone(session.id, current.first, current.second)

                val prefs = getApplication<Application>()
                    .getSharedPreferences(LocationTrackingService.PREFS, Context.MODE_PRIVATE)

                val start = prefs.getLong(
                    LocationTrackingService.tripStartKey(session.id),
                    session.startTime
                ).takeIf { it > 0L } ?: session.startTime

                val distance = db.routeDistanceKm(session.id, start, now)

                val inserted = db.addTrip(
                    sessionId = session.id,
                    latitude = current.first,
                    longitude = current.second,
                    weight = session.defaultWeight,
                    source = "SETUP",
                    startTimestamp = start,
                    distanceKm = distance,
                    durationMs = now - start,
                    preventDuplicateWithinMs = 60_000L
                )

                prefs.edit()
                    .putString(
                        LocationTrackingService.autoStateKey(session.id),
                        LocationTrackingService.AutoState.WAITING_FOR_A.name
                    )
                    .putLong(LocationTrackingService.tripStartKey(session.id), 0L)
                    .apply()

                if (inserted > 0L)
                    AppLanguage.wrap(getApplication()).getString(R.string.zone_added)
                else
                    AppLanguage.wrap(getApplication()).getString(R.string.zone_duplicate)
            }

            _dashboard.value = _dashboard.value.copy(statusMessage = message)
            refresh()
        }
    }

    fun undoLastTrip() {
        val session = _dashboard.value.session ?: return
        viewModelScope.launch {
            withContext(Dispatchers.IO) { db.undoLastTrip(session.id) }
            _dashboard.value = _dashboard.value.copy(statusMessage = AppLanguage.wrap(getApplication()).getString(R.string.trip_undone))
            refresh()
        }
    }

    fun endSession(onEnded: (Long) -> Unit) {
        val session = _dashboard.value.session ?: return
        viewModelScope.launch {
            withContext(Dispatchers.IO) { db.endSession(session.id) }
            _lastEndedId.value = session.id
            _dashboard.value = DashboardState(now = System.currentTimeMillis())
            loadHistory()
            onEnded(session.id)
        }
    }

    suspend fun getSummary(sessionId: Long): SessionSummary? =
        withContext(Dispatchers.IO) {
            val session = db.getSession(sessionId) ?: return@withContext null
            val trips = db.getTrips(sessionId)
            SessionSummary(
                session = session,
                trips = trips,
                totalDistanceKm = db.totalDistanceKm(sessionId),
                totalTons = trips.sumOf { it.weight },
                earnings = db.totalEarnings(session, trips)
            )
        }

    suspend fun sessionDetails(sessionId: Long): Triple<WorkSession?, List<Trip>, List<GpsPoint>> =
        withContext(Dispatchers.IO) {
            Triple(
                db.getSession(sessionId),
                db.getTrips(sessionId),
                db.getGpsPoints(sessionId)
            )
        }

    private fun latestLocation(): Pair<Double, Double>? {
        val prefs = getApplication<Application>()
            .getSharedPreferences(LocationTrackingService.PREFS, Context.MODE_PRIVATE)

        if (!prefs.getBoolean(LocationTrackingService.KEY_HAS_LATEST, false)) return null

        val timestamp = prefs.getLong(LocationTrackingService.KEY_LATEST_TIME, 0L)
        if (System.currentTimeMillis() - timestamp > 120_000L) return null

        return Pair(
            Double.fromBits(prefs.getLong(LocationTrackingService.KEY_LATEST_LAT_BITS, 0L)),
            Double.fromBits(prefs.getLong(LocationTrackingService.KEY_LATEST_LON_BITS, 0L))
        )
    }

    override fun onCleared() {
        db.close()
        super.onCleared()
    }
}
