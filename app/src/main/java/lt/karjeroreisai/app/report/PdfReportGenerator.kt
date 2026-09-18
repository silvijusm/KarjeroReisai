package lt.karjeroreisai.app.report

import android.content.Context
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
            textSize = 22f
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
        canvas.drawText("KARJERO REISAI – DIENOS ATASKAITA", 35f, y, title)
        y += 35f

        fun line(label: String, value: String) {
            canvas.drawText(label, 35f, y, h)
            canvas.drawText(value, 210f, y, body)
            y += 20f
        }

        line("Data:", session.date)
        line("Maršrutas:", "${session.loadingPlace} -> ${session.unloadingPlace}")
        line("Vilkikas:", session.truck.ifBlank { "-" })
        line("Puspriekabė:", session.trailer.ifBlank { "-" })
        line("Darbo pradžia:", time(session.startTime))
        line("Darbo pabaiga:", session.endTime?.let(::time) ?: "-")
        line("Reisų:", trips.size.toString())
        line("Pervežta:", "%.1f t".format(trips.sumOf { it.weight }))
        line("Visas GPS atstumas:", "%.1f km".format(totalDistanceKm))
        line("Pajamos:", "%.2f EUR".format(earnings))
        line("Tarifas:", billingText(session))

        y += 14f
        canvas.drawText("REISAI", 35f, y, title)
        y += 24f

        canvas.drawText("Nr.", 35f, y, h)
        canvas.drawText("Laikas", 70f, y, h)
        canvas.drawText("t", 140f, y, h)
        canvas.drawText("km", 190f, y, h)
        canvas.drawText("Trukmė", 250f, y, h)
        canvas.drawText("Būdas", 340f, y, h)
        y += 18f

        trips.forEach { trip ->
            if (y > 795f) return@forEach
            canvas.drawText(trip.tripNumber.toString(), 35f, y, body)
            canvas.drawText(time(trip.timestamp), 70f, y, body)
            canvas.drawText("%.1f".format(trip.weight), 140f, y, body)
            canvas.drawText("%.1f".format(trip.distanceKm), 190f, y, body)
            canvas.drawText(duration(trip.durationMs), 250f, y, body)
            canvas.drawText(trip.source, 340f, y, body)
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

    private fun billingText(session: WorkSession): String =
        when (session.billingMode) {
            BillingMode.PER_TRIP -> "%.2f EUR / reisas".format(session.rate)
            BillingMode.PER_TON -> "%.2f EUR / t".format(session.rate)
            BillingMode.PER_DAY -> "%.2f EUR / diena".format(session.rate)
            BillingMode.PER_TON_KM -> "%.4f EUR / t-km".format(session.rate)
        }
}
