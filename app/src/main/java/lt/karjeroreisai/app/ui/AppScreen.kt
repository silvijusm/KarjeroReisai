package lt.karjeroreisai.app.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.android.gms.maps.model.LatLng
import com.google.maps.android.compose.Circle
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.Polyline
import com.google.maps.android.compose.rememberMarkerState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import lt.karjeroreisai.app.R
import lt.karjeroreisai.app.data.BillingMode
import lt.karjeroreisai.app.data.GpsPoint
import lt.karjeroreisai.app.data.Trip
import lt.karjeroreisai.app.data.WorkSession
import lt.karjeroreisai.app.location.LocationTrackingService
import lt.karjeroreisai.app.report.PdfReportGenerator
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

private enum class Screen { HOME, HISTORY, MAP, SUMMARY }

@Composable
fun KarjeroReisaiApp(viewModel: MainViewModel) {
    val context = LocalContext.current
    val dashboard by viewModel.dashboard.collectAsStateWithLifecycle()
    val history by viewModel.history.collectAsStateWithLifecycle()

    var screen by remember { mutableStateOf(Screen.HOME) }
    var selectedSessionId by remember { mutableLongStateOf(-1L) }
    var pendingStart by remember { mutableStateOf<(() -> Unit)?>(null) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val granted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            result[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        if (granted) pendingStart?.invoke()
        pendingStart = null
    }

    LaunchedEffect(Unit) {
        while (true) {
            viewModel.refresh()
            delay(2_000)
        }
    }

    dashboard.statusMessage?.let { message ->
        AlertDialog(
            onDismissRequest = viewModel::clearStatusMessage,
            confirmButton = {
                TextButton(onClick = viewModel::clearStatusMessage) { Text("Gerai") }
            },
            text = { Text(message) }
        )
    }

    MaterialTheme {
        Surface(Modifier.fillMaxSize()) {
            when (screen) {
                Screen.HOME -> {
                    if (dashboard.session == null) {
                        StartScreen(
                            onStart = { loading, unloading, truck, trailer, weight, autoCount, radius, mode, rate ->
                                val action = {
                                    viewModel.startSession(
                                        loading, unloading, truck, trailer, weight,
                                        autoCount, radius, mode, rate
                                    ) { id ->
                                        startTracking(context, id)
                                    }
                                }

                                if (!hasLocationPermission(context)) {
                                    pendingStart = action
                                    permissionLauncher.launch(requiredPermissions())
                                } else action()
                            },
                            onHistory = {
                                viewModel.loadHistory()
                                screen = Screen.HISTORY
                            }
                        )
                    } else {
                        WorkScreen(
                            state = dashboard,
                            onTrip = viewModel::addTripManual,
                            onSetB = viewModel::setUnloadingZoneHereAndCountFirstTrip,
                            onUndo = viewModel::undoLastTrip,
                            onMap = {
                                selectedSessionId = dashboard.session!!.id
                                screen = Screen.MAP
                            },
                            onHistory = {
                                viewModel.loadHistory()
                                screen = Screen.HISTORY
                            },
                            onEnd = {
                                viewModel.endSession { id ->
                                    stopTracking(context)
                                    selectedSessionId = id
                                    screen = Screen.SUMMARY
                                }
                            }
                        )
                    }
                }

                Screen.HISTORY -> HistoryScreen(
                    sessions = history,
                    onBack = { screen = Screen.HOME },
                    onOpen = { id ->
                        selectedSessionId = id
                        screen = Screen.SUMMARY
                    }
                )

                Screen.MAP -> SessionMapScreen(
                    viewModel = viewModel,
                    sessionId = selectedSessionId,
                    onBack = { screen = Screen.SUMMARY }
                )

                Screen.SUMMARY -> SummaryScreen(
                    viewModel = viewModel,
                    sessionId = selectedSessionId,
                    onBack = {
                        viewModel.loadHistory()
                        screen = Screen.HISTORY
                    },
                    onHome = { screen = Screen.HOME },
                    onMap = { screen = Screen.MAP }
                )
            }
        }
    }
}

@Composable
private fun StartScreen(
    onStart: (String, String, String, String, Double, Boolean, Double, BillingMode, Double) -> Unit,
    onHistory: () -> Unit
) {
    var loading by remember { mutableStateOf("") }
    var unloading by remember { mutableStateOf("") }
    var truck by remember
