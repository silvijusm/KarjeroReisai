package lt.karjeroreisai.app.ui

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
