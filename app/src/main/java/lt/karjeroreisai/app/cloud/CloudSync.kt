package lt.karjeroreisai.app.cloud

import android.content.Context
import android.location.Location
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import lt.karjeroreisai.app.data.AppDatabase
import lt.karjeroreisai.app.data.WorkSession

/**
 * Sends work sessions, trips, the GPS route and the live position to Firestore
 * so that the company manager / dispatcher can see them.
 *
 * Firestore keeps writes in its local cache when there is no connection and
 * sends them later, so this works offline too. Route points are sent in
 * batches (≤ 400 points per document), the live position is one document per
 * driver that is overwritten (cheap).
 */
object CloudSync {
    private const val PREFS = "cloud_sync"
    private const val ROUTE_BATCH = 400
    private const val MOVING_INTERVAL_MS = 60_000L
    private const val STOPPED_INTERVAL_MS = 300_000L
    private const val MIN_MOVE_M = 30f
    const val ROUTE_SYNC_INTERVAL_MS = 300_000L

    data class Config(val companyId: String, val uid: String, val driverName: String)

    /** Called by the UI when the signed-in user may work for a company (owner or approved member). */
    fun configure(context: Context, companyId: String?, uid: String?, driverName: String, enabled: Boolean) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        if (enabled && !companyId.isNullOrBlank() && !uid.isNullOrBlank()) {
            prefs.putString("companyId", companyId).putString("uid", uid).putString("name", driverName)
        } else {
            prefs.remove("companyId").remove("uid").remove("name")
        }
        prefs.apply()
    }

    fun config(context: Context): Config? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val companyId = prefs.getString("companyId", null) ?: return null
        val uid = prefs.getString("uid", null) ?: return null
        // Never write as someone else if the account changed.
        if (FirebaseAuth.getInstance().currentUser?.uid != uid) return null
        return Config(companyId, uid, prefs.getString("name", "").orEmpty())
    }

    private fun company(companyId: String) = FirebaseFirestore.getInstance().collection("companies").document(companyId)

    private fun ownsSession(session: WorkSession, config: Config) =
        session.cloudId != null && session.companyId == config.companyId && session.driverUid == config.uid

    /** Session summary + trips (as an array – trips can be undone) + pending route points. */
    fun syncSession(context: Context, db: AppDatabase, sessionId: Long) {
        val config = config(context) ?: return
        val session = db.getSession(sessionId) ?: return
        if (!ownsSession(session, config)) return
        val trips = db.getTrips(sessionId)
        val sessionRef = company(config.companyId).collection("sessions").document(session.cloudId!!)
        val km = db.totalDistanceKm(sessionId)
        sessionRef.set(
            mapOf(
                "driverUid" to config.uid,
                "driverName" to config.driverName,
                "plate" to session.truck,
                "trailer" to session.trailer,
                "loadingPlace" to session.loadingPlace,
                "unloadingPlace" to session.unloadingPlace,
                "date" to session.date,
                "startedAtMillis" to session.startTime,
                "endedAtMillis" to session.endTime,
                "tripsCount" to trips.size,
                "tonnes" to trips.sumOf { it.weight },
                "km" to km,
                "trips" to trips.map {
                    mapOf(
                        "n" to it.tripNumber,
                        "atMillis" to it.timestamp,
                        "startMillis" to it.startTimestamp,
                        "weightT" to it.weight,
                        "km" to it.distanceKm,
                        "lat" to it.latitude,
                        "lng" to it.longitude,
                        "source" to it.source
                    )
                },
                "updatedAtMillis" to System.currentTimeMillis()
            )
        )
        // Route in batches. The document id is the first point id, so a repeated
        // upload of the same batch overwrites instead of duplicating.
        while (true) {
            val points = db.getPendingGpsPoints(sessionId, ROUTE_BATCH)
            if (points.isEmpty()) break
            val good = points.filter { it.accuracy <= 60f }
            if (good.isNotEmpty()) {
                sessionRef.collection("route").document(points.first().id.toString()).set(
                    mapOf(
                        "driverUid" to config.uid,
                        "lat" to good.map { it.latitude },
                        "lng" to good.map { it.longitude },
                        "t" to good.map { it.timestamp },
                        "firstMillis" to good.first().timestamp
                    )
                )
            }
            // The write is queued in Firestore's persistent local cache at this point.
            db.markGpsUploaded(sessionId, points.last().id)
            if (points.size < ROUTE_BATCH) break
        }
    }

    private var lastLiveAt = 0L
    private var lastLiveLat = 0.0
    private var lastLiveLng = 0.0

    /** Live position: every 60 s while moving, every 5 min while standing. */
    fun maybeSendLive(context: Context, db: AppDatabase, sessionId: Long, location: Location) {
        val config = config(context) ?: return
        val now = System.currentTimeMillis()
        val moving = location.hasSpeed() && location.speed > 1.5f
        val moved = FloatArray(1).also {
            Location.distanceBetween(lastLiveLat, lastLiveLng, location.latitude, location.longitude, it)
        }[0]
        val elapsed = now - lastLiveAt
        val due = when {
            lastLiveAt == 0L -> true
            moving -> elapsed >= MOVING_INTERVAL_MS
            else -> elapsed >= STOPPED_INTERVAL_MS || (moved >= MIN_MOVE_M && elapsed >= MOVING_INTERVAL_MS)
        }
        if (!due) return
        val session = db.getSession(sessionId) ?: return
        if (!ownsSession(session, config)) return
        val trips = db.getTrips(sessionId)
        lastLiveAt = now
        lastLiveLat = location.latitude
        lastLiveLng = location.longitude
        company(config.companyId).collection("liveLocations").document(config.uid).set(
            mapOf(
                "lat" to location.latitude,
                "lng" to location.longitude,
                "speedKmh" to (if (location.hasSpeed()) location.speed * 3.6 else 0.0),
                "heading" to (if (location.hasBearing()) location.bearing.toDouble() else 0.0),
                "accuracyM" to location.accuracy.toDouble(),
                "updatedAtMillis" to now,
                "sessionId" to session.cloudId,
                "plate" to session.truck,
                "driverName" to config.driverName,
                "state" to if (moving) "moving" else "stopped",
                "tripsCount" to trips.size,
                "tonnes" to trips.sumOf { it.weight },
                "startedAtMillis" to session.startTime
            )
        )
    }

    /** Work finished: the vehicle disappears from the "active" list. */
    fun markOffline(context: Context) {
        val config = config(context) ?: return
        lastLiveAt = 0L
        company(config.companyId).collection("liveLocations").document(config.uid)
            .set(mapOf("state" to "offline", "updatedAtMillis" to System.currentTimeMillis()), SetOptions.merge())
    }
}
