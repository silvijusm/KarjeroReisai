package lt.karjeroreisai.app.data

import android.content.Context
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class SessionSyncStoreTest {
    private lateinit var context: Context
    private lateinit var db: AppDatabase
    private val identity = SyncIdentity("driver", "company")
    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        context.databaseList().forEach { context.deleteDatabase(it) }
        context.getSharedPreferences("sync_migration", Context.MODE_PRIVATE).edit().clear().commit()
        db = AppDatabase(context, identity)
    }
    @After fun cleanup() { db.close() }
    private fun start(database: AppDatabase = db) = database.startSession("Quarry", "Site", "ABC123", "", 27.0, true, 150.0, BillingMode.PER_TRIP, 10.0)
    private fun trip(id: Long, database: AppDatabase = db) = database.addTrip(id, 55.0, 24.0, 27.0, "MANUAL", System.currentTimeMillis() - 1000, 7.0, 1000, 0)
    private fun gps(id: Long, n: Int) { repeat(n) { db.addGpsPoint(id, 100000L + it, 55.0 + it / 1e5, 24.0, 5f, 10f) } }

    @Test fun pendingEditsSurviveReopenAndAcknowledgingAnOlderSnapshot() {
        val id = start(); trip(id)
        val first = SessionSyncStore(db).nextSnapshot()!!
        db.close(); db = AppDatabase(context, identity)
        assertEquals(first.cloudId, SessionSyncStore(db).nextSnapshot()!!.cloudId)
        trip(id)
        val store = SessionSyncStore(db)
        store.acknowledge(first)
        assertEquals(1, store.pendingCount())
        val second = store.nextSnapshot()!!
        assertTrue(second.revision > first.revision)
        assertEquals(2, second.trips.size)
        store.acknowledge(second)
        assertEquals(0, store.pendingCount())
    }
    @Test fun retriesKeepCloudIdsAndGpsBucketIdsStable() {
        val id = start(); gps(id, 510)
        val store = SessionSyncStore(db)
        val first = store.nextSnapshot()!!
        assertEquals(listOf("0", "1"), first.routes.map { it.first })
        assertEquals(500, first.routes[0].second["pointCount"])
        assertEquals(10, first.routes[1].second["pointCount"])
        assertEquals(first, store.nextSnapshot())
        store.acknowledge(first)
        gps(id, 2)
        val next = store.nextSnapshot()!!
        assertEquals(listOf("1"), next.routes.map { it.first })
        assertEquals(12, next.routes.single().second["pointCount"])
    }
    @Test fun undoProducesTombstoneAndCannotResurrectTheTripOnRetry() {
        val id = start(); trip(id)
        val store = SessionSyncStore(db)
        val first = store.nextSnapshot()!!; store.acknowledge(first)
        db.undoLastTrip(id)
        val undone = store.nextSnapshot()!!
        assertEquals(first.trips.single().first, undone.trips.single().first)
        assertEquals(true, undone.trips.single().second["deleted"])
        assertEquals(0, db.getTripCount(id))
        assertEquals(0, undone.session["tripsCount"])
        trip(id)
        assertEquals(1, db.getTripCount(id))
        assertEquals(2, store.nextSnapshot()!!.trips.size)
    }
    @Test fun accountsAndCompaniesHaveSeparateLocalHistories() {
        start()
        AppDatabase(context, SyncIdentity("other", "company")).use { assertTrue(it.getSessions().isEmpty()) }
        AppDatabase(context, SyncIdentity("driver", "other")).use { assertTrue(it.getSessions().isEmpty()) }
        assertNotEquals(SyncIdentity("ab", "c").key, SyncIdentity("a", "bc").key)
    }
    @Test fun downloadedHistoryIsReadOnlyAndDoesNotStartAnActiveSession() {
        val id = start(); trip(id); gps(id, 3)
        val snapshot = SessionSyncStore(db).nextSnapshot()!!
        AppDatabase(context, SyncIdentity("driver", "other-device-test")).use { target ->
            val store = SessionSyncStore(target)
            val metadata = snapshot.session + ("completeRevision" to snapshot.revision)
            store.importRemote(snapshot.cloudId, metadata, snapshot.trips.map { it.second }, snapshot.routes.map { it.second })
            val restored = target.getSessions().single()
            assertNull(target.getActiveSession())
            assertEquals(1, target.getTrips(restored.id).size)
            assertEquals(3, target.getGpsPoints(restored.id).size)
            assertEquals(0, store.pendingCount())
            assertEquals(-1L, trip(restored.id, target))
            target.undoLastTrip(restored.id)
            assertEquals(1, target.getTrips(restored.id).size)
            store.importRemote(snapshot.cloudId, metadata, snapshot.trips.map { it.second }, snapshot.routes.map { it.second })
            assertEquals(1, target.getSessions().size)
        }
    }
    @Test fun cloudDownloadNeverOverwritesUnsyncedLocalEdits() {
        val id = start(); trip(id)
        val store = SessionSyncStore(db)
        val snapshot = store.nextSnapshot()!!
        store.importRemote(snapshot.cloudId, snapshot.session + mapOf("revision" to 999L, "completeRevision" to 999L), emptyList(), emptyList())
        assertEquals(1, db.getTripCount(id))
        assertTrue(store.nextSnapshot()!!.revision < 999)
    }
    @Test fun importLegacyIsExplicitIdempotentPreservesOriginalAndBindsOneAccount() {
        AppDatabase(context).use { old ->
            val id = start(old); trip(id, old)
        }
        assertTrue(db.getSessions().isEmpty())
        val store = SessionSyncStore(db)
        assertEquals(1, store.importLegacy(context))
        assertEquals(0, store.importLegacy(context))
        assertEquals(1, db.getTrips(db.getSessions().single().id).size)
        assertNotNull(db.getSessions().single().endTime)
        assertEquals(1, store.pendingCount())
        AppDatabase(context).use { old -> assertEquals(1, old.getSessions().size) }
        AppDatabase(context, SyncIdentity("other", "company")).use { other ->
            assertThrows(IllegalArgumentException::class.java) { SessionSyncStore(other).importLegacy(context) }
            assertTrue(other.getSessions().isEmpty())
        }
    }
    @Test fun endedSessionsIgnoreLateGpsCallbacks() {
        val id = start(); db.endSession(id)
        gps(id, 2)
        assertTrue(db.getGpsPoints(id).isEmpty())
        assertEquals(-1L, trip(id))
    }
    @Test fun polylineRoundTripAndMalformedInput() {
        val points = listOf(38.5 to -120.2, 40.7 to -120.95, 43.252 to -126.453)
        val encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
        assertEquals(encoded, RouteCodec.encode(points))
        assertEquals(points, RouteCodec.decode(encoded))
        assertThrows(IllegalArgumentException::class.java) { RouteCodec.decode("~~~~~~~") }
    }
}
