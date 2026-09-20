package lt.karjeroreisai.app

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

object AppLanguage {
    val supported = linkedMapOf("lt" to "Lietuvių", "en" to "English", "ru" to "Русский",
        "lv" to "Latviešu", "et" to "Eesti", "pl" to "Polski")

    fun selected(context: Context): String = context.getSharedPreferences("app_settings", Context.MODE_PRIVATE)
        .getString("language", "lt").takeIf { it in supported } ?: "lt"

    fun save(context: Context, language: String) {
        require(language in supported)
        context.getSharedPreferences("app_settings", Context.MODE_PRIVATE).edit()
            .putString("language", language).apply()
    }

    fun wrap(context: Context): Context {
        val locale = Locale.forLanguageTag(selected(context))
        val config = Configuration(context.resources.configuration)
        config.setLocale(locale)
        config.setLayoutDirection(locale)
        return context.createConfigurationContext(config)
    }
}
