package lt.karjeroreisai.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import lt.karjeroreisai.app.ui.KarjeroReisaiApp
import lt.karjeroreisai.app.ui.MainViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val vm: MainViewModel = viewModel()
            KarjeroReisaiApp(vm)
        }
    }
}
