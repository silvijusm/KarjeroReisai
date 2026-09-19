package lt.karjeroreisai.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun AuthScreen(
    state: AuthUiState,
    onSignIn: (String, String) -> Unit,
    onRegister: (String, String, String, String) -> Unit,
    onClearError: () -> Unit
) {
    var registerMode by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var companyName by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Column(
        modifier = Modifier.fillMaxSize().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            "Karjero reisai",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold
        )
        Text(if (registerMode) "Sukurti įmonės paskyrą" else "Prisijungti")

        if (registerMode) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Vardas") },
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = companyName,
                onValueChange = { companyName = it },
                label = { Text("Įmonės pavadinimas") },
                modifier = Modifier.fillMaxWidth()
            )
            Text("Pirmi 2 mėnesiai – bandomasis laikotarpis.")
        }

        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("El. paštas") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Slaptažodis") },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth()
        )

        state.error?.let {
            Text(it, color = MaterialTheme.colorScheme.error)
        }

        Button(
            onClick = {
                if (registerMode) onRegister(name, companyName, email, password)
                else onSignIn(email, password)
            },
            enabled = !state.loading,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(if (registerMode) "REGISTRUOTIS" else "PRISIJUNGTI")
        }

        TextButton(
            onClick = {
                registerMode = !registerMode
                onClearError()
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                if (registerMode)
                    "Jau turiu paskyrą – prisijungti"
                else
                    "Neturiu paskyros – registruotis"
            )
        }
    }
}
