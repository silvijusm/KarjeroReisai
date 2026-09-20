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
import androidx.compose.ui.res.stringResource
import lt.karjeroreisai.app.R
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.saveable.rememberSaveable
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
    onResetPassword: (String) -> Unit,
    onClearError: () -> Unit
) {
    var registerMode by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    var companyName by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            stringResource(R.string.app_name),
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold
        )
        Text(if (registerMode) stringResource(R.string.create_company) else stringResource(R.string.sign_in))

        if (registerMode) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.name)) },
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = companyName,
                onValueChange = { companyName = it },
                label = { Text(stringResource(R.string.company_name)) },
                modifier = Modifier.fillMaxWidth()
            )
            Text(stringResource(R.string.trial_intro))
        }

        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text(stringResource(R.string.email)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(stringResource(R.string.password)) },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth()
        )

        state.error?.let {
            Text(it, color = MaterialTheme.colorScheme.error)
        }
        state.infoMessage?.let {
            Text(it, color = MaterialTheme.colorScheme.primary)
        }

        Button(
            onClick = {
                if (registerMode) onRegister(name, companyName, email, password)
                else onSignIn(email, password)
            },
            enabled = !state.loading,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(if (registerMode) stringResource(R.string.register) else stringResource(R.string.sign_in))
        }

        if (!registerMode) {
            TextButton(
                onClick = { onResetPassword(email) },
                enabled = !state.loading,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.forgot_password))
            }
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
                    stringResource(R.string.have_account)
                else
                    stringResource(R.string.no_account)
            )
        }
    }
}
