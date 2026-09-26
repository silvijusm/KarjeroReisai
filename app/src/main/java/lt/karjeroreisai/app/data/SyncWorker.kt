package lt.karjeroreisai.app.data

import android.content.Context
import androidx.work.*
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.Timestamp
import com.google.firebase.firestore.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        lock.withLock {
            val uid = inputData.getString("uid") ?: return@withLock Result.failure()
            val companyId = inputData.getString("companyId") ?: return@withLock Result.failure()
            val identity = SyncIdentity(uid, companyId)
            if (!identity.canSync || FirebaseAuth.getInstance().currentUser?.uid != uid) return@withLock Result.success()
            val preferences = applicationContext.getSharedPreferences("sync_${identity.key}", Context.MODE_PRIVATE)
            fun status(value: String) { preferences.edit().putString("status", value).apply() }
            val firestore = FirebaseFirestore.getInstance()
            fun checkAccount() {
                check(!isStopped && FirebaseAuth.getInstance().currentUser?.uid == uid) { "Account changed" }
            }
            try {
                status("running")
                // Check the current server-side assignment before any upload/download.
                // Cached membership never authorizes a background sync.
                val profile = firestore.collection("users").document(uid).get(Source.SERVER).waitForResult()
                if (profile.getString("companyId") != companyId) {
                    status("blocked"); return@withLock Result.failure()
                }
                val company = firestore.collection("companies").document(companyId).get(Source.SERVER).waitForResult()
                val role = profile.getString("role")
                val allowed = if (role == "company_admin") company.getString("ownerUid") == uid
                    else if (role == "super_admin") true
                    else if (role in setOf("driver", "dispatcher")) {
                        val member = company.reference.collection("members").document(uid).get(Source.SERVER).waitForResult()
                        member.getString("status") == "active" && member.getString("role") == role
                    } else false
                if (!allowed) { status("blocked"); return@withLock Result.failure() }
                AppDatabase(applicationContext, identity).use { db ->
                    val store = SessionSyncStore(db)
                    val sessions = company.reference.collection("sessions")
                    // Bound one worker's run time; durable revisions retain remaining work.
                    var sent = 0
                    val processed = mutableSetOf<Long>()
                    while (sent < 20) {
                        checkAccount()
                        val snapshot = store.nextSnapshot(processed) ?: break
                        processed.add(snapshot.localId)
                        val ref = sessions.document(snapshot.cloudId)
                        val head = ref.get(Source.SERVER).waitForResult()
                        if (head.getLong("revision") == snapshot.revision && head.getLong("completeRevision") == snapshot.revision) {
                            store.acknowledge(snapshot); sent++; continue
                        }
                        ref.set(snapshot.session + ("updatedAt" to FieldValue.serverTimestamp())).waitForResult()
                        for ((collection, records) in listOf("trips" to snapshot.trips, "routeChunks" to snapshot.routes)) {
                            for (page in records.chunked(200)) {
                                checkAccount()
                                val batch = firestore.batch()
                                for ((id, data) in page) batch.set(ref.collection(collection).document(id), data + ("updatedAt" to FieldValue.serverTimestamp()))
                                batch.commit().waitForResult()
                            }
                        }
                        checkAccount()
                        ref.update(mapOf("completeRevision" to snapshot.revision, "updatedAt" to FieldValue.serverTimestamp())).waitForResult()
                        checkAccount()
                        store.acknowledge(snapshot)
                        sent++
                    }
                    // Download only this driver's history. Other-device sessions are
                    // read-only locally and cannot accidentally resume GPS recording.
                    var cursor: DocumentSnapshot? = null
                    var latest = Timestamp(preferences.getLong("pullSeconds", 0), preferences.getInt("pullNanos", 0))
                    val since = latest
                    do {
                        checkAccount()
                        var query: Query = sessions.whereEqualTo("driverUid", uid).orderBy("updatedAt")
                            .orderBy(FieldPath.documentId()).startAt(since).limit(100)
                        cursor?.let { query = query.startAfter(it) }
                        val page = query.get(Source.SERVER).waitForResult()
                        for (session in page.documents) {
                            session.getTimestamp("updatedAt")?.let { if (it > latest) latest = it }
                            val revision = session.getLong("revision") ?: continue
                            if (revision != session.getLong("completeRevision") || !store.needsDownload(session.id, revision)) continue
                            checkAccount()
                            val trips = session.reference.collection("trips").get(Source.SERVER).waitForResult().documents.map { it.data.orEmpty() }
                            val routes = session.reference.collection("routeChunks").get(Source.SERVER).waitForResult().documents.map { it.data.orEmpty() }
                            val verified = session.reference.get(Source.SERVER).waitForResult()
                            if (verified.getLong("revision") == revision && verified.getLong("completeRevision") == revision) {
                                checkAccount()
                                store.importRemote(session.id, session.data.orEmpty(), trips, routes)
                            }
                        }
                        cursor = if (page.size() == 100) page.documents.last() else null
                    } while (cursor != null)
                    preferences.edit().putLong("pullSeconds", latest.seconds).putInt("pullNanos", latest.nanoseconds).apply()
                    preferences.edit().putLong("lastSuccess", System.currentTimeMillis()).apply()
                    status(if (store.pendingCount() == 0) "synced" else "pending")
                    // Edits to a just-sent active session wait for the next event or
                    // five-minute GPS tick. Do not turn GPS updates into a tight loop.
                    if (store.nextSnapshot(processed) != null) Result.retry() else Result.success()
                }
            } catch (error: Exception) {
                if (FirebaseAuth.getInstance().currentUser?.uid != uid || isStopped) {
                    status("pending"); Result.success()
                } else {
                    val cause = error.cause ?: error
                    if (cause is FirebaseFirestoreException && cause.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                        status("blocked"); Result.failure()
                    } else { status("pending"); Result.retry() }
                }
            }
        }
    }

    companion object {
        private val lock = Mutex()
        private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        private fun data(identity: SyncIdentity) = workDataOf("uid" to identity.uid, "companyId" to identity.companyId)
        fun schedule(context: Context, identity: SyncIdentity) {
            if (!identity.canSync) return
            val manager = WorkManager.getInstance(context)
            manager.enqueueUniqueWork("sync-now-${identity.key}", ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<SyncWorker>().setInputData(data(identity)).setConstraints(constraints)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
        }
        fun start(context: Context, identity: SyncIdentity) {
            if (!identity.canSync) return
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("sync-periodic-${identity.key}", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                    .setInputData(data(identity)).setInitialDelay(15, TimeUnit.MINUTES).setConstraints(constraints).build())
            schedule(context, identity)
        }
        fun stop(context: Context, identity: SyncIdentity) {
            WorkManager.getInstance(context).cancelUniqueWork("sync-now-${identity.key}")
            WorkManager.getInstance(context).cancelUniqueWork("sync-periodic-${identity.key}")
        }
        private fun <T> Task<T>.waitForResult(): T = Tasks.await(this, 45, TimeUnit.SECONDS)
    }
}
