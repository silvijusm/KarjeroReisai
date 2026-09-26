package lt.karjeroreisai.app

import android.os.Bundle
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.LaunchedEffect
import lt.karjeroreisai.app.data.SyncIdentity
import lt.karjeroreisai.app.data.SyncWorker
import lt.karjeroreisai.app.ui.AuthViewModel
import lt.karjeroreisai.app.ui.KarjeroReisaiApp
import lt.karjeroreisai.app.ui.MainViewModel

class MainActivity : ComponentActivity() {
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLanguage.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val authVm: AuthViewModel = viewModel()
            val auth by authVm.state.collectAsStateWithLifecycle()
            val identity = SyncIdentity(if (auth.signedIn) auth.uid.orEmpty() else "signed-out",
                if (auth.signedIn) auth.companyId.orEmpty() else "")
            key(identity.key) {
                val mainVm: MainViewModel = viewModel(key = identity.key, factory = object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T : ViewModel> create(modelClass: Class<T>): T = MainViewModel(application, identity) as T
                })
                LaunchedEffect(identity) { if (auth.signedIn) SyncWorker.start(application, identity) }
                KarjeroReisaiApp(mainVm, authVm)
            }
        }
    }
}
