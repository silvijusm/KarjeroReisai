package lt.karjeroreisai.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import lt.karjeroreisai.app.R

data class CompanyMember(
    val uid: String,
    val name: String,
    val email: String,
    val role: String,
    val status: String
)

data class CompanyVehicle(
    val id: String,
    val plate: String,
    val name: String,
    val active: Boolean
)

private fun functions() = FirebaseFunctions.getInstance("europe-west1")

private fun companyRef(companyId: String) =
    FirebaseFirestore.getInstance().collection("companies").document(companyId)

/** Live list of company members (managers only; rules deny it to drivers). */
@Composable
fun rememberMembers(companyId: String?, enabled: Boolean): List<CompanyMember> {
    var members by remember(companyId, enabled) { mutableStateOf<List<CompanyMember>>(emptyList()) }
    DisposableEffect(companyId, enabled) {
        if (companyId.isNullOrBlank() || !enabled) return@DisposableEffect onDispose { }
        val registration = companyRef(companyId).collection("members").addSnapshotListener { snapshot, failure ->
            if (failure == null && snapshot != null) {
                members = snapshot.documents.map {
                    CompanyMember(
                        uid = it.id,
                        name = it.getString("displayName").orEmpty(),
                        email = it.getString("email").orEmpty(),
                        role = it.getString("role").orEmpty(),
                        status = it.getString("status").orEmpty()
                    )
                }.sortedBy { it.name.lowercase() }
            }
        }
        onDispose { registration.remove() }
    }
    return members
}

/** Live list of company vehicles (all active members). */
@Composable
fun rememberVehicles(companyId: String?, enabled: Boolean): List<CompanyVehicle> {
    var vehicles by remember(companyId, enabled) { mutableStateOf<List<CompanyVehicle>>(emptyList()) }
    DisposableEffect(companyId, enabled) {
        if (companyId.isNullOrBlank() || !enabled) return@DisposableEffect onDispose { }
        val registration = companyRef(companyId).collection("vehicles").addSnapshotListener { snapshot, failure ->
            if (failure == null && snapshot != null) {
                vehicles = snapshot.documents.map {
                    CompanyVehicle(
                        id = it.id,
                        plate = it.getString("plateNumber").orEmpty(),
                        name = it.getString("name").orEmpty(),
                        active = it.getBoolean("active") ?: true
                    )
                }.sortedBy { it.plate }
            }
        }
        onDispose { registration.remove() }
    }
    return vehicles
}

@Composable
fun JoinCompanyScreen(
    state: AuthUiState,
    onJoin: (code: String, name: String) -> Unit,
    onSignOut: () -> Unit
) {
    var code by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable(state.uid) { mutableStateOf(state.name) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(stringResource(R.string.join_company), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(stringResource(R.string.signed_in, state.email))
        Text(stringResource(R.string.join_company_intro))
        OutlinedTextField(
            value = name, onValueChange = { name = it },
            label = { Text(stringResource(R.string.name)) }, modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = code, onValueChange = { code = it.uppercase() },
            label = { Text(stringResource(R.string.company_code)) },
            placeholder = { Text("KR-7F3K9Q") },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
            singleLine = true, modifier = Modifier.fillMaxWidth()
        )
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = { onJoin(code, name) },
            enabled = !state.loading && code.isNotBlank() && name.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) { Text(stringResource(R.string.join_company)) }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        TextButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.sign_out)) }
    }
}

@Composable
fun PendingApprovalScreen(state: AuthUiState, onCancel: () -> Unit, onSignOut: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(stringResource(R.string.pending_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(stringResource(R.string.pending_text, state.companyName))
        LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        OutlinedButton(onClick = onCancel, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.cancel_request))
        }
        TextButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.sign_out)) }
    }
}

/** Drivers & dispatchers. Admins manage; dispatchers only see the list. */
@Composable
fun TeamScreen(auth: AuthUiState, members: List<CompanyMember>, onBack: () -> Unit) {
    val context = LocalContext.current
    val isAdmin = auth.isCompanyAdmin
    var code by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    var confirmNewCode by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf<CompanyMember?>(null) }

    fun call(name: String, data: Map<String, Any>, onOk: (Map<*, *>?) -> Unit = {}) {
        busy = true
        error = false
        functions().getHttpsCallable(name).call(data).addOnCompleteListener { result ->
            busy = false
            if (result.isSuccessful) onOk(result.result.data as? Map<*, *>) else error = true
        }
    }

    LaunchedEffect(isAdmin) {
        if (isAdmin) call("companyCode", emptyMap()) { code = it?.get("code") as? String }
    }

    confirmRemove?.let { member ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            text = { Text(stringResource(R.string.remove_confirm, member.name)) },
            confirmButton = {
                TextButton(onClick = { confirmRemove = null; call("removeMember", mapOf("uid" to member.uid)) }) {
                    Text(stringResource(R.string.remove))
                }
            },
            dismissButton = { TextButton(onClick = { confirmRemove = null }) { Text(stringResource(R.string.cancel)) } }
        )
    }
    if (confirmNewCode) {
        AlertDialog(
            onDismissRequest = { confirmNewCode = false },
            text = { Text(stringResource(R.string.new_code_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmNewCode = false
                    call("companyCode", mapOf("regenerate" to true)) { code = it?.get("code") as? String }
                }) { Text(stringResource(R.string.new_code)) }
            },
            dismissButton = { TextButton(onClick = { confirmNewCode = false }) { Text(stringResource(R.string.cancel)) } }
        )
    }

    val pending = members.filter { it.status == "pending" }
    val active = members.filter { it.status == "active" }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.team), style = MaterialTheme.typography.headlineSmall)
            TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (error) Text(stringResource(R.string.action_failed), color = MaterialTheme.colorScheme.error)

        if (isAdmin) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.company_code), style = MaterialTheme.typography.titleMedium)
                    Text(code ?: "…", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                    Text(stringResource(R.string.company_code_share_hint))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { code?.let { copyCode(context, it) } }, enabled = code != null) {
                            Text(stringResource(R.string.copy))
                        }
                        Button(onClick = { code?.let { shareCode(context, it) } }, enabled = code != null) {
                            Text(stringResource(R.string.share))
                        }
                    }
                    TextButton(onClick = { confirmNewCode = true }, enabled = !busy) { Text(stringResource(R.string.new_code)) }
                }
            }
        } else {
            Text(stringResource(R.string.manager_only_view))
        }

        if (pending.isNotEmpty()) {
            Text(stringResource(R.string.pending_requests), style = MaterialTheme.typography.titleMedium)
            pending.forEach { member ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(member.name, fontWeight = FontWeight.Bold)
                        Text(member.email, style = MaterialTheme.typography.bodySmall)
                        if (isAdmin) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { call("approveMember", mapOf("uid" to member.uid)) }, enabled = !busy) {
                                Text(stringResource(R.string.approve))
                            }
                            OutlinedButton(onClick = { call("rejectMember", mapOf("uid" to member.uid)) }, enabled = !busy) {
                                Text(stringResource(R.string.reject))
                            }
                        }
                    }
                }
            }
        }

        HorizontalDivider()
        Text(stringResource(R.string.active_members), style = MaterialTheme.typography.titleMedium)
        if (active.isEmpty()) Text(stringResource(R.string.no_members))
        active.forEach { member ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(member.name, fontWeight = FontWeight.Bold)
                    Text("${member.email} · ${stringResource(roleLabel(member.role))}", style = MaterialTheme.typography.bodySmall)
                    if (isAdmin && member.uid != auth.uid) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val next = if (member.role == "dispatcher") "driver" else "dispatcher"
                        OutlinedButton(onClick = { call("setMemberRole", mapOf("uid" to member.uid, "role" to next)) }, enabled = !busy) {
                            Text(stringResource(if (next == "dispatcher") R.string.make_dispatcher else R.string.make_driver))
                        }
                        TextButton(onClick = { confirmRemove = member }, enabled = !busy) { Text(stringResource(R.string.remove)) }
                    }
                }
            }
        }
    }
}

@Composable
fun VehiclesScreen(auth: AuthUiState, vehicles: List<CompanyVehicle>, onBack: () -> Unit) {
    val isAdmin = auth.isCompanyAdmin
    var plates by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.vehicles), style = MaterialTheme.typography.headlineSmall)
            TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
        }
        if (error) Text(stringResource(R.string.action_failed), color = MaterialTheme.colorScheme.error)
        if (isAdmin) {
            OutlinedTextField(
                value = plates, onValueChange = { plates = it.uppercase() },
                label = { Text(stringResource(R.string.plates_hint)) },
                minLines = 3, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters)
            )
            Button(
                onClick = {
                    val existing = vehicles.map { normalizePlate(it.plate) }.toSet()
                    val fresh = plates.lines().map { normalizePlate(it) }
                        .filter { it.isNotEmpty() && it.length <= 20 && it !in existing }.distinct()
                    if (fresh.isEmpty() || auth.companyId == null) { plates = ""; return@Button }
                    busy = true
                    error = false
                    val db = FirebaseFirestore.getInstance()
                    val batch = db.batch()
                    fresh.forEach { plate ->
                        batch.set(
                            companyRef(auth.companyId).collection("vehicles").document(),
                            mapOf(
                                "plateNumber" to plate, "name" to "", "active" to true,
                                "createdAt" to FieldValue.serverTimestamp(), "updatedAt" to FieldValue.serverTimestamp()
                            )
                        )
                    }
                    batch.commit().addOnCompleteListener { result ->
                        busy = false
                        if (result.isSuccessful) plates = "" else error = true
                    }
                },
                enabled = !busy && plates.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.add_vehicles)) }
        } else {
            Text(stringResource(R.string.manager_only_view))
        }
        HorizontalDivider()
        if (vehicles.isEmpty()) Text(stringResource(R.string.no_vehicles))
        vehicles.forEach { vehicle ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(vehicle.plate, fontWeight = FontWeight.Bold)
                    if (vehicle.name.isNotBlank()) Text(vehicle.name, style = MaterialTheme.typography.bodySmall)
                }
                Text(stringResource(R.string.vehicle_active), style = MaterialTheme.typography.bodySmall)
                Switch(
                    checked = vehicle.active,
                    enabled = isAdmin && !busy,
                    onCheckedChange = { value ->
                        val id = auth.companyId ?: return@Switch
                        error = false
                        companyRef(id).collection("vehicles").document(vehicle.id)
                            .update(mapOf("active" to value, "updatedAt" to FieldValue.serverTimestamp()))
                            .addOnFailureListener { error = true }
                    }
                )
            }
        }
    }
}

/** Dropdown for the start screen: picks one of the company's active vehicles. */
@Composable
fun VehiclePicker(vehicles: List<CompanyVehicle>, selectedPlate: String, onSelect: (String) -> Unit) {
    val active = vehicles.filter { it.active }
    if (active.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    Column {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
            Text(
                if (selectedPlate.isBlank()) stringResource(R.string.choose_vehicle)
                else stringResource(R.string.vehicle_value, selectedPlate)
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            active.forEach { vehicle ->
                DropdownMenuItem(
                    text = { Text(if (vehicle.name.isBlank()) vehicle.plate else "${vehicle.plate} – ${vehicle.name}") },
                    onClick = { onSelect(vehicle.plate); open = false }
                )
            }
        }
    }
}

fun roleLabel(role: String?): Int = when (role) {
    "super_admin" -> R.string.role_owner
    "company_admin" -> R.string.role_company
    "dispatcher" -> R.string.role_dispatcher
    "driver" -> R.string.role_driver
    else -> R.string.role_unknown
}

private fun normalizePlate(value: String) = value.trim().uppercase().replace(Regex("\\s+"), " ")

private fun copyCode(context: Context, code: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("code", code))
    Toast.makeText(context, context.getString(R.string.code_copied), Toast.LENGTH_SHORT).show()
}

private fun shareCode(context: Context, code: String) {
    val text = context.getString(R.string.share_code_text, code)
    val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    context.startActivity(Intent.createChooser(intent, null))
}
