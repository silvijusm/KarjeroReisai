package lt.karjeroreisai.app.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import lt.karjeroreisai.app.AppLanguage
import lt.karjeroreisai.app.R
import java.text.DateFormat
import java.util.Date

@Composable
fun SettingsScreen(auth: AuthUiState, working: Boolean, onBack: () -> Unit, onLogout: () -> Unit) {
    val context = LocalContext.current
    var adminOpen by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars)
        .verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(stringResource(if (adminOpen) R.string.admin else R.string.settings), style = MaterialTheme.typography.headlineSmall)
            TextButton(onClick = { if (adminOpen) adminOpen = false else onBack() }) { Text(stringResource(R.string.back)) }
        }
        if (adminOpen && auth.signedIn && auth.role == "super_admin") {
            AdminPanel(auth.uid.orEmpty())
        } else {
            Text(stringResource(R.string.language), style = MaterialTheme.typography.titleMedium)
            AppLanguage.supported.forEach { (code, label) ->
                OutlinedButton(onClick = {
                    AppLanguage.save(context, code)
                    context.activity()?.recreate()
                }, enabled = AppLanguage.selected(context) != code, modifier = Modifier.fillMaxWidth()) {
                    Text(if (AppLanguage.selected(context) == code) "✓ $label" else label)
                }
            }
            HorizontalDivider()
            Text(stringResource(R.string.account), style = MaterialTheme.typography.titleMedium)
            if (auth.signedIn) {
                Text(auth.email)
                Text(stringResource(roleLabel(auth.role)))
                if (auth.isMember && auth.companyName.isNotBlank()) Text(auth.companyName)
                if (auth.role == "super_admin") {
                    Button(onClick = { adminOpen = true }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.admin)) }
                } else if (auth.role == "company_admin") {
                    SubscriptionPanel(auth)
                }
                if (!auth.companyId.isNullOrBlank()) MyDataButton(auth)
                if (working) Text(stringResource(R.string.end_before_logout))
                OutlinedButton(onClick = onLogout, enabled = !working && !auth.loading, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.sign_out))
                }
            }
            androidx.compose.material3.TextButton(
                onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://silvijusm.github.io/KarjeroReisai/site/pagalba.html"))) } },
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.help)) }
            Text(stringResource(R.string.admin_hint))
            val version = remember { context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty() }
            Text(stringResource(R.string.version, version), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun SubscriptionPanel(auth: AuthUiState) {
    val context = LocalContext.current
    val functions = remember { FirebaseFunctions.getInstance("europe-west1") }
    var company by remember(auth.uid) { mutableStateOf<Map<String, Any>?>(null) }
    var billing by remember(auth.uid) { mutableStateOf<Map<*, *>?>(null) }
    var error by remember(auth.uid) { mutableIntStateOf(0) }
    var refreshing by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var plan by rememberSaveable { mutableStateOf("company") }
    DisposableEffect(auth.uid, auth.companyId, refreshing) {
        var alive = true
        loaded = false
        error = 0
        val registration = auth.companyId?.let { id ->
            FirebaseFirestore.getInstance().collection("companies").document(id).addSnapshotListener { doc, failure ->
                if (alive) {
                    if (failure != null) error = R.string.load_failed else company = doc?.data
                }
            }
        }
        functions.getHttpsCallable("billingStatus").call().addOnCompleteListener { result ->
            if (alive) {
                loaded = true
                billing = if (result.isSuccessful) result.result.data as? Map<*, *> else null
                // An undeployed backend is expected until the owner completes setup.
                if (!result.isSuccessful) error = R.string.load_failed
            }
        }
        onDispose { alive = false; registration?.remove() }
    }
    Text(stringResource(R.string.subscription), style = MaterialTheme.typography.titleMedium)
    company?.let {
        Text(stringResource(planLabel(it["plan"] as? String)))
        (it["billingPlan"] as? String)?.let { p -> billingPlanLabel(p)?.let { id -> Text(stringResource(id)) } }
        (it["seats"] as? Number)?.let { n -> Text(stringResource(R.string.seats_billed, n.toInt())) }
        (it["graceUntilMillis"] as? Number)?.let { g -> Text(stringResource(R.string.payment_failed_grace,
            DateFormat.getDateInstance(DateFormat.MEDIUM, context.resources.configuration.locales[0]).format(Date(g.toLong()))),
            color = MaterialTheme.colorScheme.error) }
        (it["trialEndsAtMillis"] as? Number)?.let { end ->
            if (it["plan"] == "trial") Text(stringResource(R.string.trial_until,
                DateFormat.getDateInstance(DateFormat.MEDIUM, context.resources.configuration.locales[0]).format(Date(end.toLong()))))
        }
    }
    if (!loaded) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (loaded && billing?.get("enabled") != true) Text(stringResource(R.string.payments_unavailable))
    if (error != 0) Text(stringResource(error), color = MaterialTheme.colorScheme.error)
    val hasSubscription = billing?.get("hasSubscription") == true
    if (billing?.get("enabled") == true) {
        if (!hasSubscription) {
            // Choose a plan before paying.
            listOf("monthly", "yearly", "company", "contractor_small", "contractor_medium", "contractor_large").forEach { p ->
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    RadioButton(selected = plan == p, onClick = { plan = p })
                    Text(stringResource(billingPlanLabel(p)!!))
                }
            }
        }
        Button(onClick = {
            busy = true
            error = 0
            val call = functions.getHttpsCallable(if (hasSubscription) "createBillingPortal" else "createCheckout")
            (if (hasSubscription) call.call() else call.call(mapOf("plan" to plan))).addOnCompleteListener { result ->
                    busy = false
                    val url = if (result.isSuccessful) (result.result.data as? Map<*, *>)?.get("url") as? String else null
                    if (url == null || !openStripeUrl(context, url)) error = R.string.payment_failed
                }
        }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(if (hasSubscription) R.string.manage_subscription else R.string.pay_card))
        }
    }
    TextButton(onClick = { refreshing++ }, enabled = !busy) { Text(stringResource(R.string.refresh)) }
}

@Composable
private fun AdminPanel(uid: String) {
    val context = LocalContext.current
    var companies by remember(uid) { mutableStateOf<List<Pair<String, Map<String, Any>>>>(emptyList()) }
    var cursor by remember(uid) { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    DisposableEffect(uid, cursor, refresh) {
        loading = true
        error = false
        var query = FirebaseFirestore.getInstance().collection("companies").orderBy(FieldPath.documentId()).limit(50)
        cursor?.let { query = query.startAfter(it) }
        val registration = query.addSnapshotListener { snapshot, failure ->
            loading = false
            error = failure != null
            companies = snapshot?.documents?.map { it.id to it.data.orEmpty() }.orEmpty()
        }
        onDispose { registration.remove() }
    }
    Text(stringResource(R.string.payout_hint))
    OutlinedButton(onClick = { openStripeUrl(context, "https://dashboard.stripe.com/") }, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.stripe_dashboard))
    }
    Text(stringResource(R.string.companies), style = MaterialTheme.typography.titleMedium)
    if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (error) Text(stringResource(R.string.load_failed), color = MaterialTheme.colorScheme.error)
    if (!loading && !error && companies.isEmpty()) Text(stringResource(R.string.no_companies))
    companies.forEach { (_, data) ->
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
                Text(data["name"] as? String ?: "—", style = MaterialTheme.typography.titleMedium)
                Text(stringResource(planLabel(data["plan"] as? String)))
            }
        }
    }
    if (companies.size == 50) TextButton(onClick = { cursor = companies.last().first }) { Text(stringResource(R.string.next_page)) }
    TextButton(onClick = { cursor = null; refresh++ }) { Text(stringResource(R.string.refresh)) }
}

fun billingPlanLabel(plan: String): Int? = when (plan) {
    "monthly" -> R.string.bplan_monthly
    "yearly" -> R.string.bplan_yearly
    "company" -> R.string.bplan_company
    "contractor_small" -> R.string.bplan_contractor_small
    "contractor_medium" -> R.string.bplan_contractor_medium
    "contractor_large" -> R.string.bplan_contractor_large
    else -> null
}

private fun planLabel(plan: String?): Int = when (plan) {
    "trial" -> R.string.plan_trial
    "paid" -> R.string.plan_active
    else -> R.string.plan_inactive
}

private fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

private fun openStripeUrl(context: Context, url: String): Boolean {
    val uri = Uri.parse(url)
    if (uri.scheme != "https" || uri.host !in setOf("checkout.stripe.com", "billing.stripe.com", "dashboard.stripe.com") || uri.userInfo != null) return false
    return runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)); true }.getOrDefault(false)
}
