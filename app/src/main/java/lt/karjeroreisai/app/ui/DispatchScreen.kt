package lt.karjeroreisai.app.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color as AColor
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.BitmapDrawable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.delay
import kotlinx.coroutines.tasks.await
import lt.karjeroreisai.app.R
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Polyline
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

data class LiveVehicle(
    val uid: String,
    val driverName: String,
    val plate: String,
    val lat: Double?,
    val lng: Double?,
    val speedKmh: Double,
    val state: String,
    val updatedAtMillis: Long,
    val tripsCount: Int,
    val tonnes: Double
)

/** moving / stopped / inactive (no update for 10 min) / offline (work finished). */
fun LiveVehicle.displayState(now: Long): String = when {
    state == "offline" -> "offline"
    now - updatedAtMillis > 10 * 60_000L -> "inactive"
    else -> state
}

private fun stateColor(state: String): Int = when (state) {
    "moving" -> AColor.rgb(46, 125, 50)
    "stopped" -> AColor.rgb(245, 124, 0)
    "loading", "unloading" -> AColor.rgb(21, 101, 192)
    "inactive" -> AColor.rgb(117, 117, 117)
    else -> AColor.rgb(189, 189, 189)
}

@Composable
private fun stateLabel(state: String): String = stringResource(
    when (state) {
        "moving" -> R.string.state_moving
        "stopped" -> R.string.state_stopped
        "inactive" -> R.string.state_inactive
        else -> R.string.state_offline
    }
)

/** Live vehicles of the company (managers only; rules deny drivers). */
@Composable
fun rememberLiveVehicles(companyId: String?, enabled: Boolean): List<LiveVehicle> {
    var vehicles by remember(companyId, enabled) { mutableStateOf<List<LiveVehicle>>(emptyList()) }
    DisposableEffect(companyId, enabled) {
        if (companyId.isNullOrBlank() || !enabled) return@DisposableEffect onDispose { }
        val registration = FirebaseFirestore.getInstance().collection("companies").document(companyId)
            .collection("liveLocations").addSnapshotListener { snapshot, failure ->
                if (failure == null && snapshot != null) {
                    vehicles = snapshot.documents.map {
                        LiveVehicle(
                            uid = it.id,
                            driverName = it.getString("driverName").orEmpty(),
                            plate = it.getString("plate").orEmpty(),
                            lat = it.getDouble("lat"),
                            lng = it.getDouble("lng"),
                            speedKmh = it.getDouble("speedKmh") ?: 0.0,
                            state = it.getString("state") ?: "offline",
                            updatedAtMillis = it.getLong("updatedAtMillis") ?: 0L,
                            tripsCount = (it.getLong("tripsCount") ?: 0L).toInt(),
                            tonnes = it.getDouble("tonnes") ?: 0.0
                        )
                    }
                }
            }
        onDispose { registration.remove() }
    }
    return vehicles
}

private data class DayRoute(val lines: List<List<GeoPoint>>, val estimated: List<List<GeoPoint>>, val trips: List<GeoPoint>, val tripsCount: Int, val tonnes: Double, val km: Double)

/** Today's sessions of one driver with their route points. */
private suspend fun loadDayRoute(companyId: String, driverUid: String): DayRoute {
    val start = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis
    val sessions = FirebaseFirestore.getInstance().collection("companies").document(companyId)
        .collection("sessions").whereGreaterThanOrEqualTo("startedAtMillis", start).get().await()
        .documents.filter { it.getString("driverUid") == driverUid }
    val lines = mutableListOf<List<GeoPoint>>()
    val trips = mutableListOf<GeoPoint>()
    var tripsCount = 0
    var tonnes = 0.0
    var km = 0.0
    for (session in sessions) {
        tripsCount += (session.getLong("tripsCount") ?: 0L).toInt()
        tonnes += session.getDouble("tonnes") ?: 0.0
        km += session.getDouble("km") ?: 0.0
        (session.get("trips") as? List<*>)?.forEach { trip ->
            val map = trip as? Map<*, *> ?: return@forEach
            val lat = (map["lat"] as? Number)?.toDouble()
            val lng = (map["lng"] as? Number)?.toDouble()
            if (lat != null && lng != null) trips += GeoPoint(lat, lng)
        }
        val chunks = session.reference.collection("route").orderBy("firstMillis").get().await().documents
        val line = mutableListOf<GeoPoint>()
        chunks.forEach { chunk ->
            val lat = chunk.get("lat") as? List<*> ?: return@forEach
            val lng = chunk.get("lng") as? List<*> ?: return@forEach
            for (i in lat.indices) {
                val a = (lat[i] as? Number)?.toDouble() ?: continue
                val b = (lng.getOrNull(i) as? Number)?.toDouble() ?: continue
                line += GeoPoint(a, b)
            }
        }
        if (line.isNotEmpty()) lines += line
    }
    val filled = RoadFill.fill(lines)
    return DayRoute(filled.solid, filled.estimated, trips, tripsCount, tonnes, km)
}

@Composable
fun DispatchScreen(auth: AuthUiState, vehicles: List<LiveVehicle>, onBack: () -> Unit) {
    val context = LocalContext.current
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var selected by remember { mutableStateOf<String?>(null) }
    var route by remember { mutableStateOf<DayRoute?>(null) }
    var routeError by remember { mutableStateOf(false) }
    var fitted by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { while (true) { delay(30_000L); now = System.currentTimeMillis() } }
    LaunchedEffect(selected) {
        route = null
        routeError = false
        val uid = selected ?: return@LaunchedEffect
        val companyId = auth.companyId ?: return@LaunchedEffect
        route = runCatching { loadDayRoute(companyId, uid) }.onFailure { routeError = true }.getOrNull()
    }

    Configuration.getInstance().userAgentValue = context.packageName
    val mapView = remember {
        MapView(context).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            controller.setZoom(8.0)
            controller.setCenter(GeoPoint(55.3, 23.9)) // Lithuania
        }
    }
    DisposableEffect(mapView) {
        mapView.onResume()
        onDispose { mapView.onPause(); mapView.onDetach() }
    }

    val sorted = vehicles.sortedWith(compareBy({ order(it.displayState(now)) }, { it.plate }))
    val onMap = sorted.filter { it.lat != null && it.lng != null && it.displayState(now) != "offline" }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.dispatch_map), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
        }
        if (!route?.estimated.isNullOrEmpty()) {
            Text(stringResource(R.string.map_estimated), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp))
        }
        AndroidView(
            modifier = Modifier.fillMaxWidth().weight(1f),
            factory = { mapView },
            update = { map ->
                map.overlays.clear()
                route?.lines?.forEach { line ->
                    map.overlays.add(Polyline().apply {
                        setPoints(line)
                        outlinePaint.color = AColor.rgb(21, 101, 192)
                        outlinePaint.strokeWidth = 8f
                    })
                }
                route?.estimated?.forEach { line ->
                    map.overlays.add(Polyline().apply {
                        setPoints(line)
                        outlinePaint.color = AColor.rgb(21, 101, 192)
                        outlinePaint.strokeWidth = 6f
                        outlinePaint.pathEffect = android.graphics.DashPathEffect(floatArrayOf(18f, 14f), 0f)
                    })
                }
                route?.trips?.forEachIndexed { i, point ->
                    map.overlays.add(Marker(map).apply {
                        position = point
                        title = context.getString(R.string.trip_number, i + 1)
                        icon = BitmapDrawable(context.resources, labelBitmap(context, "${i + 1}", AColor.rgb(21, 101, 192)))
                        setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
                    })
                }
                onMap.forEach { v ->
                    map.overlays.add(Marker(map).apply {
                        position = GeoPoint(v.lat!!, v.lng!!)
                        title = "${v.plate} – ${v.driverName}"
                        snippet = "${v.tripsCount} · ${"%.1f".format(v.tonnes)} t · ${v.speedKmh.toInt()} km/h"
                        icon = BitmapDrawable(context.resources, labelBitmap(context, v.plate.ifBlank { v.driverName.take(8) }, stateColor(v.displayState(now))))
                        setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
                        setOnMarkerClickListener { m, _ -> selected = v.uid; m.showInfoWindow(); true }
                    })
                }
                if (!fitted && onMap.isNotEmpty()) {
                    fitted = true
                    val pts = onMap.map { GeoPoint(it.lat!!, it.lng!!) }
                    if (pts.size == 1) { map.controller.setZoom(13.0); map.controller.setCenter(pts[0]) }
                    else map.post { map.zoomToBoundingBox(BoundingBox.fromGeoPoints(pts).increaseByScale(1.3f), false) }
                }
                map.invalidate()
            }
        )
        selected?.let { uid ->
            val v = vehicles.firstOrNull { it.uid == uid }
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("${v?.plate.orEmpty()} – ${v?.driverName.orEmpty()}", fontWeight = FontWeight.Bold)
                    TextButton(onClick = { selected = null }) { Text(stringResource(R.string.close)) }
                }
                when {
                    routeError -> Text(stringResource(R.string.load_failed), color = MaterialTheme.colorScheme.error)
                    route == null -> Text(stringResource(R.string.loading))
                    else -> Text(stringResource(R.string.today_summary, route!!.tripsCount, "%.1f".format(route!!.tonnes), "%.1f".format(route!!.km)))
                }
            }
        }
        HorizontalDivider()
        if (sorted.isEmpty()) {
            Text(stringResource(R.string.no_live_vehicles), modifier = Modifier.padding(12.dp))
        }
        LazyColumn(Modifier.fillMaxWidth().weight(0.8f)) {
            items(sorted, key = { it.uid }) { v ->
                val state = v.displayState(now)
                Row(
                    Modifier.fillMaxWidth().clickable {
                        selected = v.uid
                        if (v.lat != null && v.lng != null) {
                            mapView.controller.setZoom(14.0)
                            mapView.controller.animateTo(GeoPoint(v.lat, v.lng))
                        }
                    }.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Box(Modifier.size(14.dp).background(Color(stateColor(state)), CircleShape))
                    Column(Modifier.weight(1f)) {
                        Text("${v.plate.ifBlank { "—" }} · ${v.driverName}", fontWeight = FontWeight.Bold)
                        Text(
                            "${stateLabel(state)} · ${stringResource(R.string.trips_short, v.tripsCount)} · ${"%.1f".format(v.tonnes)} t",
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                    Text(timeAgo(context, now, v.updatedAtMillis), style = MaterialTheme.typography.bodySmall)
                }
                HorizontalDivider()
            }
        }
    }
}

private fun order(state: String) = when (state) { "moving" -> 0; "stopped" -> 1; "inactive" -> 2; else -> 3 }

private fun timeAgo(context: Context, now: Long, then: Long): String {
    if (then <= 0L) return ""
    val minutes = (now - then) / 60_000L
    return if (minutes < 60) context.getString(R.string.minutes_ago, minutes.coerceAtLeast(0L).toInt())
    else SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(then))
}

/** Rounded label with the plate number, coloured by state. */
internal fun labelBitmap(context: Context, text: String, color: Int): Bitmap {
    val density = context.resources.displayMetrics.density
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 13f * density
        this.color = AColor.WHITE
        isFakeBoldText = true
    }
    val padH = 7f * density
    val padV = 5f * density
    val width = (paint.measureText(text) + padH * 2).toInt().coerceAtLeast((24 * density).toInt())
    val height = (paint.textSize + padV * 2).toInt()
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
    canvas.drawRoundRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), 8f * density, 8f * density, bg)
    val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = AColor.WHITE; style = Paint.Style.STROKE; strokeWidth = 2f * density }
    canvas.drawRoundRect(RectF(1f, 1f, width - 1f, height - 1f), 8f * density, 8f * density, border)
    canvas.drawText(text, (width - paint.measureText(text)) / 2f, height / 2f - (paint.descent() + paint.ascent()) / 2f, paint)
    return bitmap
}
