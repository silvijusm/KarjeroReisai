package lt.karjeroreisai.app.ui

import androidx.lifecycle.ViewModel
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class AuthUiState(
    val loading: Boolean = true,
    val signedIn: Boolean = false,
    val uid: String? = null,
    val email: String = "",
    val name: String = "",
    val companyId: String? = null,
    val role: String? = null,
    val error: String? = null
)

class AuthViewModel : ViewModel() {
    private val auth = FirebaseAuth.getInstance()
    private val firestore = FirebaseFirestore.getInstance()

    private val _state = MutableStateFlow(AuthUiState())
    val state: StateFlow<AuthUiState> = _state.asStateFlow()

    private val authListener = FirebaseAuth.AuthStateListener { firebaseAuth ->
        val user = firebaseAuth.currentUser
        if (user == null) {
            _state.value = AuthUiState(loading = false)
        } else {
            loadProfile(user)
        }
    }

    init {
        auth.addAuthStateListener(authListener)
    }

    fun signIn(email: String, password: String) {
        val cleanEmail = email.trim()
        if (cleanEmail.isBlank() || password.isBlank()) {
            _state.value = _state.value.copy(error = "Įveskite el. paštą ir slaptažodį.")
            return
        }

        _state.value = _state.value.copy(loading = true, error = null)
        auth.signInWithEmailAndPassword(cleanEmail, password)
            .addOnFailureListener { error ->
                _state.value = AuthUiState(
                    loading = false,
                    error = "Prisijungti nepavyko: " + (error.localizedMessage ?: "nežinoma klaida")
                )
            }
    }

    fun registerCompanyAdmin(
        name: String,
        companyName: String,
        email: String,
        password: String
    ) {
        val cleanName = name.trim()
        val cleanCompany = companyName.trim()
        val cleanEmail = email.trim()

        if (cleanName.isBlank() || cleanCompany.isBlank() || cleanEmail.isBlank()) {
            _state.value = _state.value.copy(error = "Užpildykite vardą, įmonę ir el. paštą.")
            return
        }
        if (password.length < 6) {
            _state.value = _state.value.copy(error = "Slaptažodis turi būti bent 6 simbolių.")
            return
        }

        _state.value = _state.value.copy(loading = true, error = null)

        auth.createUserWithEmailAndPassword(cleanEmail, password)
            .addOnSuccessListener { result ->
                val user = result.user
                if (user == null) {
                    _state.value = AuthUiState(loading = false, error = "Nepavyko sukurti vartotojo.")
                    return@addOnSuccessListener
                }

                val companyRef = firestore.collection("companies").document()
                val userRef = firestore.collection("users").document(user.uid)
                val now = System.currentTimeMillis()
                val trialEndsAt = now + 60L * 24L * 60L * 60L * 1000L

                val batch = firestore.batch()
                batch.set(
                    companyRef,
                    mapOf(
                        "name" to cleanCompany,
                        "ownerUid" to user.uid,
                        "plan" to "trial",
                        "trialEndsAtMillis" to trialEndsAt,
                        "createdAt" to FieldValue.serverTimestamp()
                    )
                )
                batch.set(
                    userRef,
                    mapOf(
                        "email" to cleanEmail,
                        "name" to cleanName,
                        "role" to "company_admin",
                        "companyId" to companyRef.id,
                        "createdAt" to FieldValue.serverTimestamp()
                    )
                )

                batch.commit()
                    .addOnSuccessListener { loadProfile(user) }
                    .addOnFailureListener { error ->
                        user.delete()
                        _state.value = AuthUiState(
                            loading = false,
                            error = "Paskyra nesukurta: " + (error.localizedMessage ?: "duomenų bazės klaida")
                        )
                    }
            }
            .addOnFailureListener { error ->
                _state.value = AuthUiState(
                    loading = false,
                    error = "Registracija nepavyko: " + (error.localizedMessage ?: "nežinoma klaida")
                )
            }
    }

    fun signOut() {
        auth.signOut()
    }

    fun clearError() {
        _state.value = _state.value.copy(error = null)
    }

    private fun loadProfile(user: FirebaseUser) {
        _state.value = _state.value.copy(
            loading = true,
            signedIn = true,
            uid = user.uid,
            email = user.email.orEmpty(),
            error = null
        )

        firestore.collection("users").document(user.uid).get()
            .addOnSuccessListener { document ->
                _state.value = AuthUiState(
                    loading = false,
                    signedIn = true,
                    uid = user.uid,
                    email = user.email.orEmpty(),
                    name = document.getString("name").orEmpty(),
                    companyId = document.getString("companyId"),
                    role = document.getString("role"),
                    error = null
                )
            }
            .addOnFailureListener { error ->
                _state.value = AuthUiState(
                    loading = false,
                    signedIn = true,
                    uid = user.uid,
                    email = user.email.orEmpty(),
                    error = "Profilio nuskaityti nepavyko: " + (error.localizedMessage ?: "nežinoma klaida")
                )
            }
    }

    override fun onCleared() {
        auth.removeAuthStateListener(authListener)
        super.onCleared()
    }
}
