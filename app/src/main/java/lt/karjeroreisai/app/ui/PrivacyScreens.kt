package lt.karjeroreisai.app.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import lt.karjeroreisai.app.R
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Shown once to a driver / dispatcher before working for a company. */
@Composable
fun PrivacyNoticeScreen(auth: AuthUiState, retentionDays: Int, onAccept: () -> Unit, onSignOut: () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(stringResource(R.string.privacy_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(stringResource(R.string.privacy_intro, auth.companyName))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.privacy_what), fontWeight = FontWeight.Bold)
                Text(stringResource(R.string.privacy_what_text))
                Text(stringResource(R.string.privacy_when), fontWeight = FontWeight.Bold)
                Text(stringResource(R.string.privacy_when_text))
                Text(stringResource(R.string.privacy_who), fontWeight = FontWeight.Bold)
                Text(stringResource(R.string.privacy_who_text, auth.companyName))
                Text(stringResource(R.string.privacy_how_long), fontWeight = FontWeight.Bold)
                Text(stringResource(R.string.privacy_how_long_text, retentionDays))
                Text(stringResource(R.string.privacy_rights), fontWeight = FontWeight.Bold)
                Text(stringResource(R.string.privacy_rights_text))
            }
        }
        auth.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = onAccept, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.privacy_accept)) }
        TextButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.sign_out)) }
    }
}

/** "My data": exports the user's own work sessions from the cloud as a CSV file. */
@Composable
fun MyDataButton(auth: AuthUiState) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    val companyId = auth.companyId ?: return
    val uid = auth.uid ?: return
    OutlinedButton(onClick = {
        busy = true; error = false
        scope.launch {
            val file = runCatching { exportMyData(context, companyId, uid) }.getOrNull()
            busy = false
            if (file == null) error = true else shareFile(context, file, "text/csv")
        }
    }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.my_data)) }
    Text(stringResource(R.string.my_data_hint), style = MaterialTheme.typography.bodySmall)
    if (error) Text(stringResource(R.string.load_failed), color = MaterialTheme.colorScheme.error)
}

private suspend fun exportMyData(context: Context, companyId: String, uid: String): File {
    val docs = FirebaseFirestore.getInstance().collection("companies").document(companyId).collection("sessions")
        .whereEqualTo("driverUid", uid).get().await().documents.sortedBy { it.getLong("startedAtMillis") ?: 0L }
    return withContext(Dispatchers.IO) {
        val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
        fun t(ms: Long?) = ms?.let { fmt.format(Date(it)) }.orEmpty()
        fun q(v: Any?) = "\"" + (v?.toString() ?: "").replace("\"", "\"\"") + "\""
        val sb = StringBuilder("﻿")
        sb.append(listOf("session", "start", "end", "plate", "loading", "unloading", "trip", "trip_time", "tonnes", "km", "lat", "lng").joinToString(";")).append("\r\n")
        for (d in docs) {
            val base = listOf(q(d.id), q(t(d.getLong("startedAtMillis"))), q(t(d.getLong("endedAtMillis"))), q(d.getString("plate")),
                q(d.getString("loadingPlace")), q(d.getString("unloadingPlace")))
            val trips = (d.get("trips") as? List<*>).orEmpty().mapNotNull { it as? Map<*, *> }
            if (trips.isEmpty()) sb.append((base + listOf("", "", q(d.getDouble("tonnes")), q(d.getDouble("km")), "", "")).joinToString(";")).append("\r\n")
            trips.forEach { tr ->
                sb.append((base + listOf(q(tr["n"]), q(t((tr["atMillis"] as? Number)?.toLong())), q(tr["weightT"]), q(tr["km"]), q(tr["lat"]), q(tr["lng"]))).joinToString(";")).append("\r\n")
            }
        }
        val dir = context.getExternalFilesDir(android.os.Environment.DIRECTORY_DOCUMENTS) ?: context.filesDir
        if (!dir.exists()) dir.mkdirs()
        File(dir, "KarjeroReisai_mano_duomenys.csv").apply { writeText(sb.toString()) }
    }
}
