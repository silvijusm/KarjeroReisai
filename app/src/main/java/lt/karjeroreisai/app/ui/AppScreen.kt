package lt.karjeroreisai.app.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Polyline
import kotlinx.coroutines.launch
import lt.karjeroreisai.app.data.BillingMode
import lt.karjeroreisai.app.data.GpsPoint
import lt.karjeroreisai.app.data.WorkSession
import lt.karjeroreisai.app.location.LocationTrackingService
import lt.karjeroreisai.app.report.PdfReportGenerator
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private enum class Screen { HOME, HISTORY, MAP, SUMMARY }

@Composable
fun KarjeroReisaiApp(
    viewModel: MainViewModel,
    authViewModel: AuthViewModel
) {
    val context = LocalContext.current
    val dashboard by viewModel.dashboard.collectAsStateWithLifecycle()
    val history by viewModel.history.collectAsStateWithLifecycle()
    val authState by authViewModel.state.collectAsStateWithLifecycle()

    var screen by remember { mutableStateOf(Screen.HOME) }
    var selectedSessionId by remember { mutableLongStateOf(-1L) }
    var pendingStart by remember { mutableStateOf<(() -> Unit)?>(null) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val granted =
            result[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
                result[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        if (granted) pendingStart?.invoke()
        pendingStart = null
    }

    LaunchedEffect(Unit) {
        while (true) {
            viewModel.refresh()
            delay(2_000L)
        }
    }

    MaterialTheme {
        Surface(Modifier.fillMaxSize()) {
            when {
                authState.loading -> {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(20.dp),
                        verticalArrangement = Arrangement.Center
                    ) {
                        Text("Jungiama prie paskyros...")
                    }
                }

                !authState.signedIn -> {
                    AuthScreen(
                        state = authState,
                        onSignIn = authViewModel::signIn,
                        onRegister = authViewModel::registerCompanyAdmin,
                        onClearError = authViewModel::clearError
                    )
                }

                else -> {
                    dashboard.statusMessage?.let { message ->
                        AlertDialog(
                            onDismissRequest = viewModel::clearStatusMessage,
                            confirmButton = {
                                TextButton(onClick = viewModel::clearStatusMessage) { Text("Gerai") }
                            },
                            text = { Text(message) }
                        )
                    }

                    when (screen) {
                        Screen.HOME -> if (dashboard.session == null) {
                            StartScreen(
                                accountLabel = authState.email,
                                onLogout = authViewModel::signOut,
                                onStart = { loading, unloading, truck, trailer, weight, autoCount, radius, mode, rate ->
                                    val action = {
                                        viewModel.startSession(
                                            loading,
                                            unloading,
                                            truck,
                                            trailer,
                                            weight,
                                            autoCount,
                                            radius,
                                            mode,
                                            rate
                                        ) { id -> startTracking(context, id) }
                                    }

                                    if (hasLocationPermission(context)) action()
                                    else {
                                        pendingStart = action
                                        permissionLauncher.launch(requiredPermissions())
                                    }
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
    }
}

@Composable
private fun StartScreen(
    accountLabel: String,
    onLogout: () -> Unit,
    onStart: (String, String, String, String, Double, Boolean, Double, BillingMode, Double) -> Unit,
    onHistory: () -> Unit
) {
    var loading by remember { mutableStateOf("") }
    var unloading by remember { mutableStateOf("") }
    var truck by remember { mutableStateOf("") }
    var trailer by remember { mutableStateOf("") }
    var weightText by remember { mutableStateOf("27") }
    var radiusText by remember { mutableStateOf("150") }
    var rateText by remember { mutableStateOf("0") }
    var autoCount by remember { mutableStateOf(true) }
    var mode by remember { mutableStateOf(BillingMode.PER_TRIP) }
    var menuOpen by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item { Text("Karjero reisai", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold) }
        item { Text("Prisijungta: " + accountLabel) }
        item {
            TextButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) {
                Text("Atsijungti")
            }
        }
        item { OutlinedTextField(loading, { loading = it }, label = { Text("Pakrovimo vieta") }, modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(unloading, { unloading = it }, label = { Text("Iškrovimo vieta") }, modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(truck, { truck = it }, label = { Text("Vilkikas") }, modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(trailer, { trailer = it }, label = { Text("Puspriekabė") }, modifier = Modifier.fillMaxWidth()) }
        item {
            OutlinedTextField(
                weightText,
                { weightText = it },
                label = { Text("Svoris, t") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth()
            )
        }
        item {
            Row {
                Checkbox(autoCount, { autoCount = it })
                Text("Automatinis reisų skaičiavimas", modifier = Modifier.padding(top = 12.dp))
            }
        }
        item {
            OutlinedTextField(
                radiusText,
                { radiusText = it },
                label = { Text("GPS zonos spindulys, m") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth()
            )
        }
        item {
            Column {
                OutlinedButton(onClick = { menuOpen = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("Tarifas: " + billingLabel(mode))
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    BillingMode.entries.forEach { value ->
                        DropdownMenuItem(
                            text = { Text(billingLabel(value)) },
                            onClick = {
                                mode = value
                                menuOpen = false
                            }
                        )
                    }
                }
            }
        }
        item {
            OutlinedTextField(
                rateText,
                { rateText = it },
                label = { Text("Tarifo suma, EUR") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth()
            )
        }
        item {
            Button(
                onClick = {
                    onStart(
                        loading,
                        unloading,
                        truck,
                        trailer,
                        weightText.replace(',', '.').toDoubleOrNull() ?: 0.0,
                        autoCount,
                        radiusText.replace(',', '.').toDoubleOrNull() ?: 150.0,
                        mode,
                        rateText.replace(',', '.').toDoubleOrNull() ?: 0.0
                    )
                },
                enabled = loading.isNotBlank() && unloading.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) { Text("PRADĖTI DARBĄ") }
        }
        item {
            OutlinedButton(onClick = onHistory, modifier = Modifier.fillMaxWidth()) { Text("Istorija") }
        }
    }
}

@Composable
private fun WorkScreen(
    state: DashboardState,
    onTrip: () -> Unit,
    onSetB: () -> Unit,
    onUndo: () -> Unit,
    onMap: () -> Unit,
    onHistory: () -> Unit,
    onEnd: () -> Unit
) {
    val session = state.session ?: return
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text("Darbas vyksta", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text(session.loadingPlace + " → " + session.unloadingPlace)
        Text("Reisų: " + state.trips)
        Text("GPS atstumas: " + "%.1f".format(state.distanceKm) + " km")
        Text("Pervežta: " + "%.1f".format(state.totalTons) + " t")
        Text("Pajamos: " + "%.2f".format(state.earnings) + " EUR")

        if (session.autoCount && session.unloadingLat == null) {
            Button(onClick = onSetB, modifier = Modifier.fillMaxWidth()) {
                Text("Nustatyti B čia ir įrašyti pirmą reisą")
            }
        }

        Button(onClick = onTrip, modifier = Modifier.fillMaxWidth()) { Text("Įrašyti reisą") }
        OutlinedButton(onClick = onUndo, modifier = Modifier.fillMaxWidth()) { Text("Atšaukti paskutinį reisą") }
        OutlinedButton(onClick = onMap, modifier = Modifier.fillMaxWidth()) { Text("Žemėlapis") }
        OutlinedButton(onClick = onHistory, modifier = Modifier.fillMaxWidth()) { Text("Istorija") }
        Button(onClick = onEnd, modifier = Modifier.fillMaxWidth()) { Text("BAIGTI DARBĄ") }
    }
}

@Composable
private fun HistoryScreen(
    sessions: List<WorkSession>,
    onBack: () -> Unit,
    onOpen: (Long) -> Unit
) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Istorija", style = MaterialTheme.typography.headlineMedium)
            TextButton(onClick = onBack) { Text("Atgal") }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(sessions, key = { it.id }) { session ->
                OutlinedButton(onClick = { onOpen(session.id) }, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth()) {
                        Text(session.date, fontWeight = FontWeight.Bold)
                        Text(session.loadingPlace + " → " + session.unloadingPlace)
                        Text(time(session.startTime) + "–" + (session.endTime?.let(::time) ?: "..."))
                    }
                }
            }
        }
    }
}

@Composable
private fun SummaryScreen(
    viewModel: MainViewModel,
    sessionId: Long,
    onBack: () -> Unit,
    onHome: () -> Unit,
    onMap: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var summary by remember(sessionId) { mutableStateOf<SessionSummary?>(null) }

    LaunchedEffect(sessionId) { summary = viewModel.getSummary(sessionId) }

    val data = summary
    if (data == null) {
        Column(Modifier.fillMaxSize().padding(16.dp)) {
            Text("Kraunama...")
            TextButton(onClick = onBack) { Text("Atgal") }
        }
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text("Dienos suvestinė", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("Data: " + data.session.date)
        Text("Maršrutas: " + data.session.loadingPlace + " → " + data.session.unloadingPlace)
        Text("Reisų: " + data.trips.size)
        Text("Atstumas: " + "%.1f".format(data.totalDistanceKm) + " km")
        Text("Pervežta: " + "%.1f".format(data.totalTons) + " t")
        Text("Pajamos: " + "%.2f".format(data.earnings) + " EUR")

        Button(onClick = onMap, modifier = Modifier.fillMaxWidth()) { Text("Žemėlapis") }

        Button(
            onClick = {
                scope.launch {
                    val file = PdfReportGenerator.create(
                        context,
                        data.session,
                        data.trips,
                        data.totalDistanceKm,
                        data.earnings
                    )
                    val uri = FileProvider.getUriForFile(
                        context,
                        context.packageName + ".fileprovider",
                        file
                    )
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "application/pdf"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    context.startActivity(Intent.createChooser(send, "Dalintis PDF"))
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) { Text("Sukurti / dalintis PDF") }

        OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Atgal į istoriją") }
        OutlinedButton(onClick = onHome, modifier = Modifier.fillMaxWidth()) { Text("Pradinis ekranas") }
    }
}

@Composable
private fun SessionMapScreen(
    viewModel: MainViewModel,
    sessionId: Long,
    onBack: () -> Unit
) {
    val context = LocalContext.current
    var points by remember(sessionId) { mutableStateOf<List<GpsPoint>>(emptyList()) }

    LaunchedEffect(sessionId) {
        val details = viewModel.sessionDetails(sessionId)
        points = details.third.filter { it.accuracy <= 60f }
    }

    Configuration.getInstance().userAgentValue = context.packageName

    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(8.dp),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text("Maršruto žemėlapis", fontWeight = FontWeight.Bold)
            TextButton(onClick = onBack) { Text("Atgal") }
        }

        if (points.isEmpty()) {
            Text("Šiam darbui GPS taškų nėra.", modifier = Modifier.padding(16.dp))
        } else {
            val mapView = remember(sessionId) {
                MapView(context).apply {
                    setTileSource(TileSourceFactory.MAPNIK)
                    setMultiTouchControls(true)
                    controller.setZoom(14.0)
                }
            }

            DisposableEffect(mapView) {
                mapView.onResume()
                onDispose {
                    mapView.onPause()
                    mapView.onDetach()
                }
            }

            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { mapView },
                update = { map ->
                    map.overlays.clear()

                    val geoPoints = points.map { GeoPoint(it.latitude, it.longitude) }
                    if (geoPoints.isNotEmpty()) {
                        val routeLine = Polyline().apply {
                            setPoints(geoPoints)
                            outlinePaint.strokeWidth = 7f
                        }
                        map.overlays.add(routeLine)

                        val startMarker = Marker(map).apply {
                            position = geoPoints.first()
                            title = "Pradžia"
                            setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
                        }
                        map.overlays.add(startMarker)

                        val endMarker = Marker(map).apply {
                            position = geoPoints.last()
                            title = "Pabaiga"
                            setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
                        }
                        map.overlays.add(endMarker)

                        map.controller.setCenter(geoPoints.last())
                    }
                    map.invalidate()
                }
            )
        }
    }
}

private fun hasLocationPermission(context: Context): Boolean {
    val fine = ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.ACCESS_FINE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED
    val coarse = ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.ACCESS_COARSE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED
    return fine || coarse
}

private fun requiredPermissions(): Array<String> {
    val result = mutableListOf(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        result += Manifest.permission.POST_NOTIFICATIONS
    }
    return result.toTypedArray()
}

private fun startTracking(context: Context, sessionId: Long) {
    val intent = Intent(context, LocationTrackingService::class.java)
        .putExtra(LocationTrackingService.EXTRA_SESSION_ID, sessionId)
    ContextCompat.startForegroundService(context, intent)
}

private fun stopTracking(context: Context) {
    context.stopService(Intent(context, LocationTrackingService::class.java))
}

private fun billingLabel(mode: BillingMode): String =
    when (mode) {
        BillingMode.PER_TRIP -> "EUR / reisas"
        BillingMode.PER_TON -> "EUR / t"
        BillingMode.PER_DAY -> "EUR / diena"
        BillingMode.PER_TON_KM -> "EUR / t-km"
    }

private fun time(ms: Long): String =
    SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))
