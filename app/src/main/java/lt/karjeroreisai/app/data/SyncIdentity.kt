package lt.karjeroreisai.app.data

import android.content.Context
import java.security.MessageDigest
import java.util.UUID

data class SyncIdentity(val uid: String, val companyId: String) {
    val key: String get() = MessageDigest.getInstance("SHA-256")
        .digest("$uid\u0000$companyId".toByteArray()).joinToString("") { "%02x".format(it) }
    val databaseName: String get() = "work_$key.db"
    val preferencesName: String get() = "location_$key"
    val canSync: Boolean get() = uid.isNotBlank() && companyId.isNotBlank()

    companion object {
        @Synchronized fun deviceId(context: Context): String {
            val file = java.io.File(context.noBackupFilesDir, "sync-device-id")
            if (file.exists()) return file.readText()
            return UUID.randomUUID().toString().also { file.writeText(it) }
        }
    }
}
