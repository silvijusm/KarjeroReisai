package lt.karjeroreisai.app.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.asPaddingValues
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
import androidx.compose.ui.res.stringResource
import lt.karjeroreisai.app.R
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.google.firebase.firestore.FirebaseFirestore
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

private enum class Screen { HOME, HISTORY, MAP, SUMMARY, TEAM, VEHICLES }

@Composable
fun KarjeroReisaiApp(
    viewModel: MainViewModel,
    authViewModel: AuthViewModel
) {
    val context = LocalContext.current
    val dashboard by viewModel.dashboard.collectAsStateWithLifecycle()
    val history by viewModel.history.collectAsStateWithLifecycle()
    val authState by authViewModel.state.collectAsStateWithLifecycle()

    var screen by rememberSaveable { mutableStateOf(Screen.HOME) }
    var selectedSessionId by rememberSaveable { mutableLongStateOf(-1L) }
    var pendingStart by remember { mutableStateOf<(() -> Unit)?>(null) }
    var nowMillis by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var companyPlan by remember(authState.uid, authState.companyId) { mutableStateOf<String?>(null) }
    var trialEndsAtMillis by remember(authState.uid, authState.companyId) { mutableLongStateOf(0L) }
    var entitlementLoading by remember(authState.uid, authState.companyId) { mutableStateOf(false) }

    val activeMember = authState.isMember && authState.memberStatus == "active"
    DisposableEffect(authState.signedIn, authState.role, authState.companyId, activeMember) {
        if (authState.signedIn && (authState.role == "company_admin" || activeMember) && !authState.companyId.isNullOrBlank()) {
            entitlementLoading = true
            val registration = FirebaseFirestore.getInstance()
                .collection("companies")
                .document(authState.companyId!!)
                .addSnapshotListener { document, failure ->
                    entitlementLoading = false
                    if (failure == null && document != null && document.exists()) {
                        companyPlan = document.getString("plan")
                        trialEndsAtMillis = document.getLong("trialEndsAtMillis") ?: 0L
                    } else {
                        companyPlan = null
                        trialEndsAtMillis = 0L
                    }
                }
            onDispose { registration.remove() }
        } else {
            entitlementLoading = false
            companyPlan = if (authState.role == "super_admin") "paid" else null
            trialEndsAtMillis = 0L
            onDispose { }
        }
    }

    val canStartWork =
        authState.role == "super_admin" ||
            ((authState.role == "company_admin" || activeMember) &&
                (companyPlan == "paid" || (companyPlan == "trial" && trialEndsAtMillis > nowMillis)))

    // Company data for managers (members) and for everyone in the company (vehicles).
    val members = rememberMembers(authState.companyId, authState.signedIn && authState.isManager)
    val vehicles = rememberVehicles(
        authState.companyId,
        authState.signedIn && (authState.isCompanyAdmin || activeMember)
    )

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
            nowMillis = System.currentTimeMillis()
            delay(2_000L)
        }
    }

    var settingsOpen by rememberSaveable { mutableStateOf(false) }

    MaterialTheme {
        if (settingsOpen) {
            androidx.compose.ui.window.Dialog(
                onDismissRequest = { settingsOpen = false },
                properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)
            ) {
                Surface(Modifier.fillMaxSize()) {
                    SettingsScreen(authState, dashboard.session != null,
                        onBack = { settingsOpen = false },
                        onLogout = { authViewModel.signOut(); settingsOpen = false })
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
          Column(Modifier.fillMaxSize().padding(androidx.compose.foundation.layout.WindowInsets.systemBars.asPaddingValues())) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { settingsOpen = true }) { Text(stringResource(R.string.settings)) }
            }
            androidx.compose.foundation.layout.Box(Modifier.weight(1f)) {
            when {
                authState.loading -> {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(20.dp),
                        verticalArrangement = Arrangement.Center
                    ) {
                        Text(stringResource(R.string.connecting))
                    }
                }

                !authState.signedIn -> {
                    AuthScreen(
                        state = authState,
                        onSignIn = authViewModel::signIn,
                        onRegister = authViewModel::registerCompanyAdmin,
                        onRegisterDriver = authViewModel::registerDriver,
                        onResetPassword = authViewModel::resetPassword,
                        onClearError = authViewModel::clearError
                    )
                }

                authState.needsCompany -> {
                    JoinCompanyScreen(
                        state = authState,
                        onJoin = authViewModel::joinCompany,
                        onSignOut = authViewModel::signOut
                    )
                }

                authState.isMember && authState.memberStatus == null -> {
                    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.Center) {
                        Text(stringResource(R.string.connecting))
                    }
                }

                authState.isMember && authState.memberStatus == "pending" -> {
                    PendingApprovalScreen(
                        state = authState,
                        onCancel = authViewModel::cancelJoinRequest,
                        onSignOut = authViewModel::signOut
                    )
                }

                else -> {
                    dashboard.statusMessage?.let { message ->
                        AlertDialog(
                            onDismissRequest = viewModel::clearStatusMessage,
                            confirmButton = {
                                TextButton(onClick = viewModel::clearStatusMessage) { Text(stringResource(R.string.ok)) }
                            },
                            text = { Text(message) }
                        )
                    }

                    when (screen) {
                        Screen.HOME -> if (dashboard.session == null) {
                            StartScreen(
                                accountLabel = authState.email,
                                companyLine = if (authState.isMember) "${authState.companyName} · ${stringResource(roleLabel(authState.role))}" else null,
                                vehicles = vehicles,
                                isManager = authState.isManager,
                                pendingCount = members.count { it.status == "pending" },
                                onTeam = { screen = Screen.TEAM },
                                onVehicles = { screen = Screen.VEHICLES },
                                canStartWork = canStartWork,
                                entitlementLoading = entitlementLoading,
                                onSubscription = { settingsOpen = true },
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

                        Screen.TEAM -> TeamScreen(authState, members, onBack = { screen = Screen.HOME })

                        Screen.VEHICLES -> VehiclesScreen(authState, vehicles, onBack = { screen = Screen.HOME })

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
        }
}

@Composable
private fun StartScreen(
    accountLabel: String,
    companyLine: String?,
    vehicles: List<CompanyVehicle>,
    isManager: Boolean,
    pendingCount: Int,
    onTeam: () -> Unit,
    onVehicles: () -> Unit,
    canStartWork: Boolean,
    entitlementLoading: Boolean,
    onSubscription: () -> Unit,
    onLogout: () -> Unit,
    onStart: (String, String, String, String, Double, Boolean, Double, BillingMode, Double) -> Unit,
    onHistory: () -> Unit
) {
    var loading by rememberSaveable { mutableStateOf("") }
    var unloading by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("company_prefs", Context.MODE_PRIVATE) }
    // The last chosen company vehicle is remembered for the next work day.
    var truck by rememberSaveable { mutableStateOf(prefs.getString("last_vehicle_plate", "").orEmpty()) }
    var trailer by rememberSaveable { mutableStateOf("") }
    var weightText by rememberSaveable { mutableStateOf("27") }
    var radiusText by rememberSaveable { mutableStateOf("150") }
    var rateText by rememberSaveable { mutableStateOf("0") }
    var autoCount by rememberSaveable { mutableStateOf(true) }
    var mode by rememberSaveable { mutableStateOf(BillingMode.PER_TRIP) }
    var menuOpen by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item { Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold) }
        item { Text(stringResource(R.string.signed_in, accountLabel)) }
        companyLine?.let { line -> item { Text(line, fontWeight = FontWeight.Bold) } }
        if (isManager) {
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onTeam, modifier = Modifier.weight(1f)) {
                        Text(if (pendingCount > 0) stringResource(R.string.team_pending, pendingCount) else stringResource(R.string.team))
                    }
                    OutlinedButton(onClick = onVehicles, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.vehicles)) }
                }
            }
        }
        item {
            TextButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.sign_out))
            }
        }
        item { OutlinedTextField(loading, { loading = it }, label = { Text(stringResource(R.string.loading_place)) }, modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(unloading, { unloading = it }, label = { Text(stringResource(R.string.unloading_place)) }, modifier = Modifier.fillMaxWidth()) }
        if (vehicles.any { it.active }) {
            item {
                VehiclePicker(vehicles, truck) { plate ->
                    truck = plate
                    prefs.edit().putString("last_vehicle_plate", plate).apply()
                }
            }
        }
        item { OutlinedTextField(truck, { truck = it }, label = { Text(stringResource(R.string.truck)) }, modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(trailer, { trailer = it }, label = { Text(stringResource(R.string.trailer)) }, modifier = Modifier.fillMaxWidth()) }
        item {
            OutlinedTextField(
                weightText,
                { weightText = it },
                label = { Text(stringResource(R.string.weight)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth()
            )
        }
        item {
            Row {
                Checkbox(autoCount, { autoCount = it })
                Text(stringResource(R.string.auto_count), modifier = Modifier.padding(top = 12.dp))
            }
        }
        item {
            OutlinedTextField(
                radiusText,
                { radiusText = it },
                label = { Text(stringResource(R.string.gps_radius)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth()
            )
        }
        item {
            Column {
                OutlinedButton(onClick = { menuOpen = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.rate, billingLabel(mode)))
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
                label = { Text(stringResource(R.string.rate_amount)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth()
            )
        }
        if (entitlementLoading) {
            item { Text(stringResource(R.string.loading)) }
        } else if (!canStartWork) {
            item { Text(stringResource(R.string.plan_inactive), color = MaterialTheme.colorScheme.error) }
            item {
                Button(onClick = onSubscription, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.subscription))
                }
            }
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
                enabled = canStartWork && !entitlementLoading && loading.isNotBlank() && unloading.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.start_work)) }
        }
        item {
            OutlinedButton(onClick = onHistory, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.history)) }
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
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(stringResource(R.string.work_active), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text(session.loadingPlace + " → " + session.unloadingPlace)
        Text(stringResource(R.string.trips_count, state.trips))
        Text(stringResource(R.string.gps_distance, "%.1f".format(state.distanceKm)))
        Text(stringResource(R.string.transported, "%.1f".format(state.totalTons)))
        Text(stringResource(R.string.earnings, "%.2f".format(state.earnings)))

        if (session.autoCount && session.unloadingLat == null) {
            Button(onClick = onSetB, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.set_b))
            }
        }

        Button(onClick = onTrip, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.add_trip)) }
        OutlinedButton(onClick = onUndo, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.undo_trip)) }
        OutlinedButton(onClick = onMap, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.map)) }
        OutlinedButton(onClick = onHistory, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.history)) }
        Button(onClick = onEnd, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.end_work)) }
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
            Text(stringResource(R.string.history), style = MaterialTheme.typography.headlineMedium)
            TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
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
            Text(stringResource(R.string.loading))
            TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
        }
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(stringResource(R.string.summary), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text(stringResource(R.string.date_value, data.session.date))
        Text(stringResource(R.string.route_value, data.session.loadingPlace + " → " + data.session.unloadingPlace))
        Text(stringResource(R.string.trips_count, data.trips.size))
        Text(stringResource(R.string.distance, "%.1f".format(data.totalDistanceKm)))
        Text(stringResource(R.string.transported, "%.1f".format(data.totalTons)))
        Text(stringResource(R.string.earnings, "%.2f".format(data.earnings)))

        Button(onClick = onMap, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.map)) }

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
                    context.startActivity(Intent.createChooser(send, context.getString(R.string.share_pdf)))
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) { Text(stringResource(R.string.create_pdf)) }

        OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.back_history)) }
        OutlinedButton(onClick = onHome, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.home)) }
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
            Text(stringResource(R.string.route_map), fontWeight = FontWeight.Bold)
            TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
        }

        if (points.isEmpty()) {
            Text(stringResource(R.string.no_gps), modifier = Modifier.padding(16.dp))
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
                            title = context.getString(R.string.start)
                            setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
                        }
                        map.overlays.add(startMarker)

                        val endMarker = Marker(map).apply {
                            position = geoPoints.last()
                            title = context.getString(R.string.end)
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

@Composable
private fun billingLabel(mode: BillingMode): String =
    when (mode) {
        BillingMode.PER_TRIP -> stringResource(R.string.per_trip)
        BillingMode.PER_TON -> stringResource(R.string.per_ton)
        BillingMode.PER_DAY -> stringResource(R.string.per_day)
        BillingMode.PER_TON_KM -> stringResource(R.string.per_ton_km)
    }

private fun time(ms: Long): String =
    SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))
