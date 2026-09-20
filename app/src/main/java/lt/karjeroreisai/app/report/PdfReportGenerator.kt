package lt.karjeroreisai.app.report

import android.content.Context
import lt.karjeroreisai.app.R
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.os.Environment
import lt.karjeroreisai.app.data.AppDatabase
import lt.karjeroreisai.app.data.BillingMode
import lt.karjeroreisai.app.data.Trip
import lt.karjeroreisai.app.data.WorkSession
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

object PdfReportGenerator {

    fun create(
        context: Context,
        session: WorkSession,
        trips: List<Trip>,
        totalDistanceKm: Double,
        earnings: Double
    ): File {
        val docs = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS)
            ?: context.filesDir
        if (!docs.exists()) docs.mkdirs()

        val safeDate = session.date.replace("[^0-9-]".toRegex(), "_")
        val file = File(docs, "Karjero_reisai_$safeDate.pdf")

        val document = PdfDocument()
        val pageInfo = PdfDocument.PageInfo.Builder(595, 842, 1).create()
        val page = document.startPage(pageInfo)
        val canvas = page.canvas

        val title = Paint().apply {
            textSize = 16f
            isFakeBoldText = true
        }
        val h = Paint().apply {
            textSize = 13f
            isFakeBoldText = true
        }
        val body = Paint().apply {
            textSize = 11f
        }

        var y = 45f
        canvas.drawText(context.getString(R.string.report_title), 35f, y, title)
        y += 35f

        fun line(label: String, value: String) {
            canvas.drawText(label, 35f, y, h)
            canvas.drawText(value, 210f, y, body)
            y += 20f
        }

        line(context.getString(R.string.date_value, "").trim(), session.date)
        line(context.getString(R.string.route_value, "").trim(), "${session.loadingPlace} -> ${session.unloadingPlace}")
        line(context.getString(R.string.truck), session.truck.ifBlank { "-" })
        line(context.getString(R.string.trailer), session.trailer.ifBlank { "-" })
        line(context.getString(R.string.report_start), time(session.startTime))
        line(context.getString(R.string.report_end), session.endTime?.let(::time) ?: "-")
        line(context.getString(R.string.report_trips), trips.size.toString())
        line(context.getString(R.string.transported, "").substringBefore(":"), "%.1f t".format(trips.sumOf { it.weight }))
        line(context.getString(R.string.gps_distance, "").substringBefore(":"), "%.1f km".format(totalDistanceKm))
        line(context.getString(R.string.earnings, "").substringBefore(":"), "%.2f EUR".format(earnings))
        line(context.getString(R.string.rate, "").trim(), billingText(context, session))

        y += 14f
        canvas.drawText(context.getString(R.string.report_trips), 35f, y, title)
        y += 24f

        canvas.drawText("Nr.", 35f, y, h)
        canvas.drawText(context.getString(R.string.report_time), 70f, y, h)
        canvas.drawText("t", 140f, y, h)
        canvas.drawText("km", 190f, y, h)
        canvas.drawText(context.getString(R.string.report_duration), 250f, y, h)
        canvas.drawText(context.getString(R.string.report_source), 340f, y, h)
        y += 18f

        trips.forEach { trip ->
            if (y > 795f) return@forEach
            canvas.drawText(trip.tripNumber.toString(), 35f, y, body)
            canvas.drawText(time(trip.timestamp), 70f, y, body)
            canvas.drawText("%.1f".format(trip.weight), 140f, y, body)
            canvas.drawText("%.1f".format(trip.distanceKm), 190f, y, body)
            canvas.drawText(duration(trip.durationMs), 250f, y, body)
            canvas.drawText(context.getString(if (trip.source == "AUTO") R.string.report_auto else R.string.report_manual), 340f, y, body)
            y += 17f
        }

        document.finishPage(page)
        FileOutputStream(file).use { document.writeTo(it) }
        document.close()
        return file
    }

    private fun time(ms: Long): String =
        SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))

    private fun duration(ms: Long): String {
        val min = TimeUnit.MILLISECONDS.toMinutes(ms.coerceAtLeast(0))
        return "%02d:%02d".format(min / 60, min % 60)
    }

    private fun billingText(context: Context, session: WorkSession): String =
        when (session.billingMode) {
            BillingMode.PER_TRIP -> "%.2f".format(session.rate) + " " + context.getString(R.string.per_trip)
            BillingMode.PER_TON -> "%.2f".format(session.rate) + " " + context.getString(R.string.per_ton)
            BillingMode.PER_DAY -> "%.2f".format(session.rate) + " " + context.getString(R.string.per_day)
            BillingMode.PER_TON_KM -> "%.2f".format(session.rate) + " " + context.getString(R.string.per_ton_km)
        }
}
