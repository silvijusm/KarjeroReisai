package lt.karjeroreisai.app.ui

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.location.Location
import android.os.Build
import android.os.Environment
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeEncoder
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import lt.karjeroreisai.app.R
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

data class Material(val name: String, val densityTm3: Double, val tonnesPerTrip: Double)

data class ObjectInfo(
    val id: String,
    val contractorId: String,
    val name: String,
    val objectCode: String,
    val quarryName: String,
    val unloadName: String,
    val quarryLat: Double?,
    val quarryLng: Double?,
    val quarryRadiusM: Double,
    val distanceKm: Double,
    val materials: List<Material>,
    val vehicleTonnes: Map<String, Double>,
    val allowLoaderOverride: Boolean
)

data class ObjectLink(
    val objectId: String,
    val contractorId: String,
    val contractorName: String,
    val objectName: String,
    val objectCode: String,
    val status: String
)

data class LoadRecord(
    val id: String,
    val plate: String,
    val carrierId: String,
    val carrierName: String,
    val material: String,
    val tonnes: Double,
    val loadedAtMillis: Long,
    val loaderUid: String,
    val loaderName: String,
    val status: String,
    val driverNote: String
)

/** QR sticker content: KR1|carrierCompanyId|plate */
fun vehicleQr(carrierId: String, plate: String) = "KR1|$carrierId|$plate"

fun parseVehicleQr(text: String?): Pair<String, String>? {
    val parts = text?.split('|') ?: return null
    if (parts.size != 3 || parts[0] != "KR1" || parts[1].isBlank() || parts[2].isBlank()) return null
    return parts[1] to parts[2]
}

private fun db() = FirebaseFirestore.getInstance()
private fun functions() = FirebaseFunctions.getInstance("europe-west1")
private fun objectRef(contractorId: String, objectId: String) =
    db().collection("companies").document(contractorId).collection("objects").document(objectId)

fun todayStartMillis(): Long = Calendar.getInstance().apply {
    set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
}.timeInMillis

private fun objectFrom(contractorId: String, doc: com.google.firebase.firestore.DocumentSnapshot): ObjectInfo {
    val materials = (doc.get("materials") as? List<*>).orEmpty().mapNotNull { m ->
        val map = m as? Map<*, *> ?: return@mapNotNull null
        Material(
            name = map["name"] as? String ?: return@mapNotNull null,
            densityTm3 = (map["densityTm3"] as? Number)?.toDouble() ?: 1.6,
            tonnesPerTrip = (map["tonnesPerTrip"] as? Number)?.toDouble() ?: 0.0
        )
    }
    val vehicleTonnes = (doc.get("vehicleTonnes") as? Map<*, *>).orEmpty().mapNotNull { (k, v) ->
        val plate = k as? String ?: return@mapNotNull null
        val t = (v as? Number)?.toDouble() ?: return@mapNotNull null
        plate.uppercase() to t
    }.toMap()
    return ObjectInfo(
        id = doc.id, contractorId = contractorId,
        name = doc.getString("name").orEmpty(),
        objectCode = doc.getString("objectCode").orEmpty(),
        quarryName = doc.getString("quarryName").orEmpty(),
        unloadName = doc.getString("unloadName").orEmpty(),
        quarryLat = doc.getDouble("quarryLat"), quarryLng = doc.getDouble("quarryLng"),
        quarryRadiusM = doc.getDouble("quarryRadiusM") ?: 300.0,
        distanceKm = doc.getDouble("distanceKm") ?: 0.0,
        materials = materials, vehicleTonnes = vehicleTonnes,
        allowLoaderOverride = doc.getBoolean("allowLoaderOverride") ?: false
    )
}

private fun loadFrom(doc: com.google.firebase.firestore.DocumentSnapshot) = LoadRecord(
    id = doc.id,
    plate = doc.getString("plate").orEmpty(),
    carrierId = doc.getString("carrierId").orEmpty(),
    carrierName = doc.getString("carrierName").orEmpty(),
    material = doc.getString("material").orEmpty(),
    tonnes = doc.getDouble("tonnes") ?: 0.0,
    loadedAtMillis = doc.getLong("loadedAtMillis") ?: 0L,
    loaderUid = doc.getString("loaderUid").orEmpty(),
    loaderName = doc.getString("loaderName").orEmpty(),
    status = doc.getString("status").orEmpty(),
    driverNote = doc.getString("driverNote").orEmpty()
)

/** Objects the carrier company works on (joined with an OB- code). */
@Composable
fun rememberObjectLinks(companyId: String?, enabled: Boolean): List<ObjectLink> {
    var links by remember(companyId, enabled) { mutableStateOf<List<ObjectLink>>(emptyList()) }
    DisposableEffect(companyId, enabled) {
        if (companyId.isNullOrBlank() || !enabled) return@DisposableEffect onDispose { }
        val reg = db().collection("companies").document(companyId).collection("objectLinks")
            .addSnapshotListener { snap, failure ->
                if (failure == null && snap != null) links = snap.documents.map {
                    ObjectLink(
                        objectId = it.id,
                        contractorId = it.getString("contractorId").orEmpty(),
                        contractorName = it.getString("contractorName").orEmpty(),
                        objectName = it.getString("objectName").orEmpty(),
                        objectCode = it.getString("objectCode").orEmpty(),
                        status = it.getString("status").orEmpty()
                    )
                }.sortedBy { it.objectName }
            }
        onDispose { reg.remove() }
    }
    return links
}

// ---------------------------------------------------------------------------
// Carrier manager: objects list + join with code
// ---------------------------------------------------------------------------

@Composable
fun ObjectsScreen(auth: AuthUiState, links: List<ObjectLink>, onBack: () -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<Int?>(null) }
    var error by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.objects), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
            TextButton(onClick = onBack) { Text("← " + stringResource(R.string.back), maxLines = 1, softWrap = false) }
        }
        Text(stringResource(R.string.objects_intro))
        if (auth.isCompanyAdmin) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.join_object), fontWeight = FontWeight.Bold)
                    OutlinedTextField(
                        value = code, onValueChange = { code = it.uppercase() },
                        label = { Text(stringResource(R.string.object_code)) }, placeholder = { Text("OB-7F3K9Q") },
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters)
                    )
                    Button(onClick = {
                        busy = true; message = null; error = false
                        functions().getHttpsCallable("joinObject").call(mapOf("code" to code.trim())).addOnCompleteListener { r ->
                            busy = false
                            if (r.isSuccessful) { code = ""; message = R.string.object_join_sent }
                            else {
                                error = true
                                message = when ((r.exception as? FirebaseFunctionsException)?.code) {
                                    FirebaseFunctionsException.Code.NOT_FOUND -> R.string.object_wrong_code
                                    FirebaseFunctionsException.Code.ALREADY_EXISTS -> R.string.object_already
                                    FirebaseFunctionsException.Code.RESOURCE_EXHAUSTED -> R.string.join_too_many
                                    else -> R.string.action_failed
                                }
                            }
                        }
                    }, enabled = !busy && code.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.join_object)) }
                    message?.let { Text(stringResource(it), color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) }
                }
            }
        }
        HorizontalDivider()
        if (links.isEmpty()) Text(stringResource(R.string.no_objects))
        links.forEach { link ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(link.objectName + if (link.objectCode.isNotBlank()) " (${link.objectCode})" else "", fontWeight = FontWeight.Bold)
                    Text(link.contractorName, style = MaterialTheme.typography.bodySmall)
                    Text(stringResource(linkStatusLabel(link.status)), color = if (link.status == "active") Color(0xFF2E7D32) else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

fun linkStatusLabel(status: String) = when (status) {
    "active" -> R.string.link_active
    "pending" -> R.string.link_pending
    else -> R.string.link_removed
}

// ---------------------------------------------------------------------------
// Driver: object picker on the start screen
// ---------------------------------------------------------------------------

@Composable
fun ObjectPicker(links: List<ObjectLink>, selected: ObjectLink?, onSelect: (ObjectLink?, ObjectInfo?) -> Unit) {
    val active = links.filter { it.status == "active" }
    if (active.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    Column {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
            Text(selected?.let { stringResource(R.string.object_value, it.objectName) } ?: stringResource(R.string.choose_object))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.no_object)) }, onClick = { open = false; onSelect(null, null) })
            active.forEach { link ->
                DropdownMenuItem(text = { Text("${link.objectName} – ${link.contractorName}") }, onClick = {
                    open = false
                    objectRef(link.contractorId, link.objectId).get()
                        .addOnSuccessListener { doc -> onSelect(link, if (doc.exists()) objectFrom(link.contractorId, doc) else null) }
                        .addOnFailureListener { onSelect(link, null) }
                })
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Driver: loads registered by the excavator operator – confirm or dispute
// ---------------------------------------------------------------------------

@Composable
fun DriverLoadsPanel(carrierId: String?, contractorId: String?, objectId: String?, plate: String, since: Long, trips: Int) {
    val context = LocalContext.current
    var loads by remember(objectId, plate) { mutableStateOf<List<LoadRecord>>(emptyList()) }
    var disputing by remember { mutableStateOf<LoadRecord?>(null) }
    var note by remember { mutableStateOf("") }
    val notified = remember { mutableSetOf<String>() }
    DisposableEffect(carrierId, contractorId, objectId, plate) {
        if (carrierId == null || contractorId == null || objectId == null || plate.isBlank()) return@DisposableEffect onDispose { }
        val reg = objectRef(contractorId, objectId).collection("loads")
            .whereEqualTo("carrierId", carrierId).whereEqualTo("plate", plate)
            .whereGreaterThanOrEqualTo("loadedAtMillis", since)
            .addSnapshotListener { snap, failure ->
                if (failure != null || snap == null) return@addSnapshotListener
                loads = snap.documents.map(::loadFrom).filter { it.status != "cancelled" }.sortedByDescending { it.loadedAtMillis }
                loads.filter { it.status == "loaded" && notified.add(it.id) }.forEach { notifyLoad(context, it) }
            }
        onDispose { reg.remove() }
    }
    if (loads.isEmpty()) return
    disputing?.let { load ->
        AlertDialog(
            onDismissRequest = { disputing = null },
            title = { Text(stringResource(R.string.load_dispute)) },
            text = { OutlinedTextField(note, { note = it }, label = { Text(stringResource(R.string.comment)) }, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(onClick = { answerLoad(contractorId!!, objectId!!, load.id, "disputed", note); disputing = null; note = "" }) { Text(stringResource(R.string.send)) } },
            dismissButton = { TextButton(onClick = { disputing = null }) { Text(stringResource(R.string.cancel)) } }
        )
    }
    val confirmed = loads.filter { it.status == "confirmed" }
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color(0xFFFFF4EA))) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.loads_today, loads.size, "%.1f".format(loads.sumOf { it.tonnes })), fontWeight = FontWeight.Bold)
            val check = loadCheck(loads.size, trips)
            Text(stringResource(R.string.loads_vs_trips, loads.size, trips) + " – " + stringResource(loadCheckText(check)),
                color = if (check.isError()) ERR_RED else OK_GREEN, fontWeight = FontWeight.Bold)
            loads.filter { it.status == "loaded" }.forEach { load ->
                Text(stringResource(R.string.load_line, "%.1f".format(load.tonnes), load.material, hm(load.loadedAtMillis), load.loaderName))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { answerLoad(contractorId!!, objectId!!, load.id, "confirmed", "") }) { Text(stringResource(R.string.confirm)) }
                    OutlinedButton(onClick = { disputing = load }) { Text(stringResource(R.string.load_dispute)) }
                }
            }
            if (confirmed.isNotEmpty()) Text(stringResource(R.string.loads_confirmed, confirmed.size), style = MaterialTheme.typography.bodySmall)
        }
    }
}

private fun answerLoad(contractorId: String, objectId: String, loadId: String, status: String, note: String) {
    val uid = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid ?: return
    objectRef(contractorId, objectId).collection("loads").document(loadId).update(
        mapOf("status" to status, "driverUid" to uid, "driverNote" to note.trim().take(300), "confirmedAtMillis" to System.currentTimeMillis())
    )
}

private fun notifyLoad(context: Context, load: LoadRecord) {
    if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel("loads", context.getString(R.string.loads_channel), NotificationManager.IMPORTANCE_HIGH))
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    val pending = android.app.PendingIntent.getActivity(context, 0, intent, android.app.PendingIntent.FLAG_IMMUTABLE)
    manager.notify(load.id.hashCode(), NotificationCompat.Builder(context, "loads")
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle(context.getString(R.string.loaded_title))
        .setContentText(context.getString(R.string.load_line, "%.1f".format(load.tonnes), load.material, hm(load.loadedAtMillis), load.loaderName))
        .setContentIntent(pending).setAutoCancel(true).build())
}

private fun hm(ms: Long) = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))

// ---------------------------------------------------------------------------
// Excavator operator (loader): one tap per load
// ---------------------------------------------------------------------------

private data class Candidate(
    val carrierId: String, val carrierName: String, val plate: String, val distanceM: Float?,
    val lat: Double? = null, val lng: Double? = null, val tripsCount: Int = 0
)

/**
 * Loads (by the excavator) vs trips (counted by the driver's app).
 * A truck may be one load ahead of its trips while driving to the unloading place;
 * anything else means a load or a trip was missed.
 */
enum class LoadCheck { OK, IN_TRANSIT, MORE_LOADS, MORE_TRIPS }

fun loadCheck(loads: Int, trips: Int): LoadCheck = when (loads - trips) {
    0 -> LoadCheck.OK
    1 -> LoadCheck.IN_TRANSIT
    in 2..Int.MAX_VALUE -> LoadCheck.MORE_LOADS
    else -> LoadCheck.MORE_TRIPS
}

fun loadCheckText(check: LoadCheck) = when (check) {
    LoadCheck.OK -> R.string.check_ok
    LoadCheck.IN_TRANSIT -> R.string.check_in_transit
    LoadCheck.MORE_LOADS -> R.string.check_more_loads
    LoadCheck.MORE_TRIPS -> R.string.check_more_trips
}

fun LoadCheck.isError() = this == LoadCheck.MORE_LOADS || this == LoadCheck.MORE_TRIPS
private val OK_GREEN = Color(0xFF2E7D32)
private val ERR_RED = Color(0xFFC62828)

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun LoaderScreen(auth: AuthUiState, onSettings: () -> Unit) {
    val context = LocalContext.current
    val companyId = auth.companyId ?: return
    val prefs = remember { context.getSharedPreferences("loader", Context.MODE_PRIVATE) }
    var objects by remember { mutableStateOf<List<ObjectInfo>>(emptyList()) }
    var objectId by remember { mutableStateOf(prefs.getString("objectId", null)) }
    var carriers by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var nearby by remember { mutableStateOf<List<Candidate>>(emptyList()) }
    // Trips counted today by each truck's app (also after the driver finished work).
    var tripsByPlate by remember { mutableStateOf<Map<String, Int>>(emptyMap()) }
    var loads by remember { mutableStateOf<List<LoadRecord>>(emptyList()) }
    var chosen by remember { mutableStateOf<Candidate?>(null) }
    var material by remember { mutableStateOf<String?>(prefs.getString("material", null)) }
    var otherAmount by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var manualPlate by remember { mutableStateOf("") }
    var manualCarrier by remember { mutableStateOf<String?>(null) }
    var carrierMenu by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf<String?>(null) }
    var mapMode by remember { mutableStateOf(prefs.getBoolean("mapMode", true)) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000L); now = System.currentTimeMillis() } }

    DisposableEffect(companyId) {
        val reg = db().collection("companies").document(companyId).collection("objects").whereEqualTo("status", "active")
            .addSnapshotListener { snap, failure ->
                if (failure == null && snap != null) {
                    objects = snap.documents.map { objectFrom(companyId, it) }.sortedBy { it.name }
                    if (objectId == null || objects.none { it.id == objectId }) objectId = objects.firstOrNull()?.id
                }
            }
        onDispose { reg.remove() }
    }
    val obj = objects.firstOrNull { it.id == objectId }
    if (material == null || obj?.materials?.none { it.name == material } == true) material = obj?.materials?.firstOrNull()?.name

    DisposableEffect(objectId) {
        val id = objectId ?: return@DisposableEffect onDispose { }
        prefs.edit().putString("objectId", id).apply()
        val ref = objectRef(companyId, id)
        val r1 = ref.collection("carriers").whereEqualTo("status", "active").addSnapshotListener { snap, f ->
            if (f == null && snap != null) carriers = snap.documents.associate { it.id to (it.getString("carrierName") ?: it.id) }
        }
        val r2 = ref.collection("live").addSnapshotListener { snap, f ->
            if (f != null || snap == null) return@addSnapshotListener
            val o = objects.firstOrNull { it.id == id }
            val today = todayStartMillis()
            tripsByPlate = snap.documents.filter { (it.getLong("startedAtMillis") ?: 0L) >= today }
                .groupBy { it.getString("plate").orEmpty().uppercase() }
                .mapValues { (_, docs) -> docs.sumOf { (it.getLong("tripsCount") ?: 0L).toInt() } }
            nearby = snap.documents.mapNotNull { d ->
                val state = d.getString("state") ?: return@mapNotNull null
                val updated = d.getLong("updatedAtMillis") ?: 0L
                if (state == "offline" || System.currentTimeMillis() - updated > 30 * 60_000L) return@mapNotNull null
                val lat = d.getDouble("lat"); val lng = d.getDouble("lng")
                val dist = if (o?.quarryLat != null && o.quarryLng != null && lat != null && lng != null)
                    FloatArray(1).also { Location.distanceBetween(o.quarryLat, o.quarryLng, lat, lng, it) }[0] else null
                Candidate(d.getString("carrierId").orEmpty(), d.getString("carrierName").orEmpty(), d.getString("plate").orEmpty(), dist,
                    lat, lng, (d.getLong("tripsCount") ?: 0L).toInt())
            }.filter { it.plate.isNotBlank() && it.carrierId.isNotBlank() }
                .sortedWith(compareBy({ it.distanceM ?: Float.MAX_VALUE }, { it.plate }))
        }
        val r3 = ref.collection("loads").whereGreaterThanOrEqualTo("loadedAtMillis", todayStartMillis()).addSnapshotListener { snap, f ->
            if (f == null && snap != null) loads = snap.documents.map(::loadFrom).sortedByDescending { it.loadedAtMillis }
        }
        onDispose { r1.remove(); r2.remove(); r3.remove() }
    }

    val scan = rememberLauncherForActivityResult(ScanContract()) { result ->
        val parsed = parseVehicleQr(result.contents)
        when {
            result.contents == null -> Unit
            parsed == null -> info = context.getString(R.string.qr_unknown)
            !carriers.containsKey(parsed.first) -> info = context.getString(R.string.qr_not_on_object, parsed.second)
            else -> { chosen = Candidate(parsed.first, carriers[parsed.first].orEmpty(), parsed.second, null); info = null }
        }
    }

    fun tonnesFor(c: Candidate): Double {
        val o = obj ?: return 0.0
        return o.vehicleTonnes[c.plate.uppercase()] ?: o.materials.firstOrNull { it.name == material }?.tonnesPerTrip ?: 0.0
    }

    fun register(c: Candidate) {
        val o = obj ?: return
        val override = otherAmount.replace(',', '.').toDoubleOrNull()
        val tonnes = if (o.allowLoaderOverride && override != null) override else tonnesFor(c)
        if (tonnes <= 0.0 || tonnes > 100.0) { info = context.getString(R.string.tonnes_not_set); return }
        val density = o.materials.firstOrNull { it.name == material }?.densityTm3 ?: 1.6
        val nowMs = System.currentTimeMillis()
        objectRef(companyId, o.id).collection("loads").document().set(
            mapOf(
                "plate" to c.plate, "carrierId" to c.carrierId, "carrierName" to c.carrierName.ifBlank { carriers[c.carrierId].orEmpty() },
                "material" to (material ?: ""), "tonnes" to tonnes, "m3" to (if (density > 0) tonnes / density else 0.0),
                "distanceKm" to o.distanceKm, "loadedAtMillis" to nowMs, "createdAtMillis" to nowMs,
                "loaderUid" to auth.uid, "loaderName" to auth.name.ifBlank { auth.email },
                "source" to if (c.distanceM == null) "qr" else "list",
                "note" to note.trim().take(300), "status" to "loaded"
            )
        ).addOnFailureListener { info = context.getString(R.string.action_failed) }
        // Works offline too: the write is queued and the list updates immediately.
        info = context.getString(R.string.loaded_ok, c.plate, "%.1f".format(tonnes))
        chosen = null; otherAmount = ""; note = ""
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.loader_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(onClick = onSettings) { Text(stringResource(R.string.settings), maxLines = 1, softWrap = false) }
        }
        if (objects.isEmpty()) { Text(stringResource(R.string.loader_no_objects)); return@Column }
        if (objects.size > 1) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            objects.forEach { o -> FilterChip(selected = o.id == objectId, onClick = { objectId = o.id }, label = { Text(o.name) }) }
        } else Text(obj?.name.orEmpty(), fontWeight = FontWeight.Bold)
        if (obj != null && obj.materials.size > 1) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
            obj.materials.forEach { m -> FilterChip(selected = m.name == material, onClick = { material = m.name; prefs.edit().putString("material", m.name).apply() }, label = { Text(m.name) }) }
        }
        info?.let { Text(it, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold) }

        val c = chosen
        if (c != null) {
            // Confirmation card: one big button, works with gloves.
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color(0xFFFFF4EA))) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(c.plate, fontSize = 34.sp, fontWeight = FontWeight.Black)
                    Text(c.carrierName.ifBlank { carriers[c.carrierId].orEmpty() })
                    Text("${"%.1f".format(tonnesFor(c))} t · ${material.orEmpty()}", fontSize = 22.sp)
                    if (obj?.allowLoaderOverride == true) {
                        OutlinedTextField(otherAmount, { otherAmount = it }, label = { Text(stringResource(R.string.other_amount)) },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(note, { note = it }, label = { Text(stringResource(R.string.comment)) }, modifier = Modifier.fillMaxWidth())
                    }
                    Button(onClick = { register(c) }, modifier = Modifier.fillMaxWidth().height(96.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D32))) {
                        Text(stringResource(R.string.loaded_button), fontSize = 30.sp, fontWeight = FontWeight.Black)
                    }
                    TextButton(onClick = { chosen = null }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.cancel)) }
                }
            }
        } else {
            Button(onClick = {
                scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setBeepEnabled(true)
                    .setOrientationLocked(false).setPrompt(context.getString(R.string.scan_prompt)))
            }, modifier = Modifier.fillMaxWidth().height(80.dp)) { Text(stringResource(R.string.scan_qr), fontSize = 24.sp, fontWeight = FontWeight.Bold) }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = mapMode, onClick = { mapMode = true; prefs.edit().putBoolean("mapMode", true).apply() }, label = { Text(stringResource(R.string.loader_mode_map)) })
                FilterChip(selected = !mapMode, onClick = { mapMode = false; prefs.edit().putBoolean("mapMode", false).apply() }, label = { Text(stringResource(R.string.loader_mode_list)) })
            }
            val active = loads.filter { it.status != "cancelled" }
            val loadsByPlate = active.groupBy { it.plate.uppercase() }
            val recentlyLoaded = active.filter { now - it.loadedAtMillis < 10 * 60_000L }.map { it.plate.uppercase() }.toSet()
            if (mapMode && obj != null) {
                Text(stringResource(R.string.tap_to_load), style = MaterialTheme.typography.bodySmall)
                LoaderMap(obj, nearby, loadsByPlate, recentlyLoaded) { chosen = it; info = null }
                Text(stringResource(R.string.map_legend), style = MaterialTheme.typography.bodySmall)
            } else {
                Text(stringResource(R.string.vehicles_near), fontWeight = FontWeight.Bold)
                if (nearby.isEmpty()) Text(stringResource(R.string.no_vehicles_near), style = MaterialTheme.typography.bodySmall)
                nearby.forEach { cand ->
                    val inQuarry = obj != null && cand.distanceM != null && cand.distanceM <= obj.quarryRadiusM
                    OutlinedButton(onClick = { chosen = cand; info = null }, modifier = Modifier.fillMaxWidth().height(64.dp),
                        colors = if (inQuarry && cand.plate.uppercase() !in recentlyLoaded) ButtonDefaults.outlinedButtonColors(containerColor = Color(0xFFE8F5E9)) else ButtonDefaults.outlinedButtonColors()) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text(cand.plate, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                            Text(cand.distanceM?.let { if (it < 1000) "${it.toInt()} m" else "${"%.1f".format(it / 1000)} km" } ?: "", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
            // Loads vs trips per truck – mismatch shown as an error.
            VehicleCheckTable(loadsByPlate, tripsByPlate)
            // Manual fallback: plate + carrier.
            Text(stringResource(R.string.manual_entry), fontWeight = FontWeight.Bold)
            OutlinedTextField(manualPlate, { manualPlate = it.uppercase() }, label = { Text(stringResource(R.string.truck)) },
                singleLine = true, keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters), modifier = Modifier.fillMaxWidth())
            Column {
                OutlinedButton(onClick = { carrierMenu = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(manualCarrier?.let { carriers[it] } ?: stringResource(R.string.choose_carrier))
                }
                DropdownMenu(expanded = carrierMenu, onDismissRequest = { carrierMenu = false }) {
                    carriers.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { manualCarrier = id; carrierMenu = false }) }
                }
            }
            OutlinedButton(onClick = {
                chosen = Candidate(manualCarrier!!, carriers[manualCarrier].orEmpty(), manualPlate.trim(), -1f)
                manualPlate = ""
            }, enabled = manualPlate.isNotBlank() && manualCarrier != null, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.next)) }
        }

        HorizontalDivider()
        val mine = loads.filter { it.status != "cancelled" }
        Text(stringResource(R.string.loads_today, mine.size, "%.1f".format(mine.sumOf { it.tonnes })), fontWeight = FontWeight.Bold)
        mine.forEach { l ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${hm(l.loadedAtMillis)} · ${l.plate} · ${"%.1f".format(l.tonnes)} t", fontWeight = FontWeight.Bold)
                    Text("${l.carrierName} · ${l.material} · ${stringResource(loadStatusLabel(l.status))}", style = MaterialTheme.typography.bodySmall)
                }
                if (l.loaderUid == auth.uid && l.status == "loaded" && now - l.loadedAtMillis < 15 * 60_000L) {
                    TextButton(onClick = { objectRef(companyId, objectId!!).collection("loads").document(l.id).update("status", "cancelled") }) {
                        Text(stringResource(R.string.cancel))
                    }
                }
            }
        }
    }
}

/** Map for the excavator operator: trucks at the quarry are green; tap one to register the load. */
@Composable
private fun LoaderMap(
    obj: ObjectInfo,
    trucks: List<Candidate>,
    loadsByPlate: Map<String, List<LoadRecord>>,
    recentlyLoaded: Set<String>,
    onPick: (Candidate) -> Unit
) {
    val context = LocalContext.current
    org.osmdroid.config.Configuration.getInstance().userAgentValue = context.packageName
    val map = remember(obj.id) {
        org.osmdroid.views.MapView(context).apply {
            setTilesScaledToDpi(true)
            setTileSource(org.osmdroid.tileprovider.tilesource.TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            controller.setZoom(if (obj.quarryLat != null) 15.5 else 8.0)
            controller.setCenter(org.osmdroid.util.GeoPoint(obj.quarryLat ?: 55.3, obj.quarryLng ?: 23.9))
            // Let the map, not the page, handle finger drags.
            setOnTouchListener { v, _ -> v.parent?.requestDisallowInterceptTouchEvent(true); false }
        }
    }
    DisposableEffect(map) { map.onResume(); onDispose { map.onPause(); map.onDetach() } }
    androidx.compose.ui.viewinterop.AndroidView(
        modifier = Modifier.fillMaxWidth().height(380.dp),
        factory = { map },
        update = { m ->
            m.overlays.clear()
            if (obj.quarryLat != null && obj.quarryLng != null) {
                m.overlays.add(org.osmdroid.views.overlay.Polygon(m).apply {
                    points = org.osmdroid.views.overlay.Polygon.pointsAsCircle(org.osmdroid.util.GeoPoint(obj.quarryLat, obj.quarryLng), obj.quarryRadiusM)
                    fillPaint.color = android.graphics.Color.argb(40, 232, 116, 12)
                    outlinePaint.color = android.graphics.Color.rgb(232, 116, 12)
                    outlinePaint.strokeWidth = 4f
                })
            }
            trucks.filter { it.lat != null && it.lng != null }.forEach { t ->
                val plate = t.plate.uppercase()
                val loaded = loadsByPlate[plate]?.size ?: 0
                val check = loadCheck(loaded, t.tripsCount)
                val inQuarry = t.distanceM != null && t.distanceM <= obj.quarryRadiusM
                val color = when {
                    check.isError() -> android.graphics.Color.rgb(198, 40, 40)
                    plate in recentlyLoaded -> android.graphics.Color.rgb(21, 101, 192)
                    inQuarry -> android.graphics.Color.rgb(46, 125, 50)
                    else -> android.graphics.Color.rgb(117, 117, 117)
                }
                m.overlays.add(org.osmdroid.views.overlay.Marker(m).apply {
                    position = org.osmdroid.util.GeoPoint(t.lat!!, t.lng!!)
                    icon = android.graphics.drawable.BitmapDrawable(context.resources,
                        labelBitmap(context, "${t.plate}  $loaded/${t.tripsCount}" + if (check.isError()) " !" else "", color))
                    setAnchor(org.osmdroid.views.overlay.Marker.ANCHOR_CENTER, org.osmdroid.views.overlay.Marker.ANCHOR_BOTTOM)
                    setOnMarkerClickListener { _, _ -> onPick(t); true }
                })
            }
            m.invalidate()
        }
    )
}

/** Per truck today: loads registered vs trips counted – red when they do not match. */
@Composable
private fun VehicleCheckTable(loadsByPlate: Map<String, List<LoadRecord>>, tripsByPlate: Map<String, Int>) {
    val plates = (loadsByPlate.keys + tripsByPlate.keys).filter { it.isNotBlank() }.sorted()
    if (plates.isEmpty()) return
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.truck), Modifier.weight(1.3f), fontWeight = FontWeight.Bold)
                Text(stringResource(R.string.col_loaded), Modifier.weight(1f), fontWeight = FontWeight.Bold)
                Text(stringResource(R.string.col_trips), Modifier.weight(1f), fontWeight = FontWeight.Bold)
                Text("", Modifier.weight(1.6f))
            }
            plates.forEach { plate ->
                val loaded = loadsByPlate[plate]?.size ?: 0
                val trips = tripsByPlate[plate] ?: 0
                val check = loadCheck(loaded, trips)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(plate, Modifier.weight(1.3f), fontWeight = FontWeight.Bold)
                    Text("$loaded", Modifier.weight(1f))
                    Text("$trips", Modifier.weight(1f))
                    Text(stringResource(loadCheckText(check)), Modifier.weight(1.6f),
                        color = if (check.isError()) ERR_RED else OK_GREEN, fontWeight = if (check.isError()) FontWeight.Bold else FontWeight.Normal)
                }
            }
        }
    }
}

fun loadStatusLabel(status: String) = when (status) {
    "confirmed" -> R.string.load_confirmed
    "disputed" -> R.string.load_disputed
    "cancelled" -> R.string.load_cancelled
    else -> R.string.load_waiting
}

// ---------------------------------------------------------------------------
// QR stickers for the windscreen (PDF, 2 × 3 per A4 page)
// ---------------------------------------------------------------------------

suspend fun createQrStickers(context: Context, carrierId: String, companyName: String, plates: List<String>): File =
    withContext(Dispatchers.IO) {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS) ?: context.filesDir
        if (!dir.exists()) dir.mkdirs()
        val file = File(dir, "KarjeroReisai_QR.pdf")
        val pdf = PdfDocument()
        val encoder = BarcodeEncoder()
        val perPage = 6
        val text = Paint().apply { textSize = 30f; isFakeBoldText = true; textAlign = Paint.Align.CENTER }
        val small = Paint().apply { textSize = 12f; textAlign = Paint.Align.CENTER }
        val border = Paint().apply { style = Paint.Style.STROKE; strokeWidth = 1f; color = android.graphics.Color.LTGRAY }
        plates.chunked(perPage).forEachIndexed { pageIndex, chunk ->
            val page = pdf.startPage(PdfDocument.PageInfo.Builder(595, 842, pageIndex + 1).create())
            chunk.forEachIndexed { i, plate ->
                val col = i % 2; val row = i / 2
                val left = 20f + col * 280f; val top = 20f + row * 270f
                page.canvas.drawRect(left, top, left + 275f, top + 265f, border)
                val bmp: Bitmap = encoder.encodeBitmap(vehicleQr(carrierId, plate), BarcodeFormat.QR_CODE, 190, 190)
                page.canvas.drawBitmap(bmp, left + 42f, top + 12f, null)
                page.canvas.drawText(plate, left + 137f, top + 232f, text)
                page.canvas.drawText("$companyName · KarjeroReisai", left + 137f, top + 254f, small)
            }
            pdf.finishPage(page)
        }
        FileOutputStream(file).use { pdf.writeTo(it) }
        pdf.close()
        file
    }

fun shareFile(context: Context, file: File, mime: String) {
    val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, null))
}
