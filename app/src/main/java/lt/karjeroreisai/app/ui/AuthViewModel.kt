package lt.karjeroreisai.app.ui

import android.app.Application
import android.content.Intent
import lt.karjeroreisai.app.location.LocationTrackingService
import lt.karjeroreisai.app.data.SyncIdentity
import lt.karjeroreisai.app.data.SyncWorker
import com.google.firebase.firestore.ListenerRegistration
import lt.karjeroreisai.app.R
import lt.karjeroreisai.app.AppLanguage
import androidx.lifecycle.AndroidViewModel
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
    val error: String? = null,
    val infoMessage: String? = null
)

class AuthViewModel(app: Application) : AndroidViewModel(app) {
    private fun message(id: Int) = AppLanguage.wrap(getApplication()).getString(id)
    private var registering = false
    private var profileListener: ListenerRegistration? = null
    private val auth = FirebaseAuth.getInstance()
    private val firestore = FirebaseFirestore.getInstance()

    private val _state = MutableStateFlow(AuthUiState())
    val state: StateFlow<AuthUiState> = _state.asStateFlow()

    private val authListener = FirebaseAuth.AuthStateListener { firebaseAuth ->
        if (registering) return@AuthStateListener
        val user = firebaseAuth.currentUser
        if (user == null) {
            profileListener?.remove()
            stopAccountWork()
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
            _state.value = _state.value.copy(error = message(R.string.credentials_required))
            return
        }

        _state.value = _state.value.copy(loading = true, error = null, infoMessage = null)
        auth.signInWithEmailAndPassword(cleanEmail, password)
            .addOnFailureListener { error ->
                _state.value = AuthUiState(
                    loading = false,
                    error = message(R.string.sign_in_failed)
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
            _state.value = _state.value.copy(error = message(R.string.registration_required))
            return
        }
        if (password.length < 6) {
            _state.value = _state.value.copy(error = message(R.string.password_short))
            return
        }

        _state.value = _state.value.copy(loading = true, error = null, infoMessage = null)

        registering = true
        auth.createUserWithEmailAndPassword(cleanEmail, password)
            .addOnSuccessListener { result ->
                val user = result.user
                if (user == null) {
                    registering = false
                    _state.value = AuthUiState(loading = false, error = message(R.string.registration_failed))
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
                    .addOnSuccessListener { registering = false; loadProfile(user) }
                    .addOnFailureListener { error ->
                        registering = false
                        user.delete()
                        auth.signOut()
                        _state.value = AuthUiState(
                            loading = false,
                            error = message(R.string.registration_failed)
                        )
                    }
            }
            .addOnFailureListener { error ->
                _state.value = AuthUiState(
                    loading = false,
                    error = message(R.string.registration_failed)
                )
                registering = false
            }
    }

    fun resetPassword(email: String) {
        val cleanEmail = email.trim()
        if (cleanEmail.isBlank()) {
            _state.value = _state.value.copy(
                error = message(R.string.email_required),
                infoMessage = null
            )
            return
        }

        _state.value = _state.value.copy(loading = true, error = null, infoMessage = null)
        auth.sendPasswordResetEmail(cleanEmail)
            .addOnSuccessListener {
                _state.value = _state.value.copy(
                    loading = false,
                    error = null,
                    infoMessage = message(R.string.reset_sent)
                )
            }
            .addOnFailureListener { error ->
                _state.value = _state.value.copy(
                    loading = false,
                    error = message(R.string.reset_failed),
                    infoMessage = null
                )
            }
    }

    fun signOut() {
        stopAccountWork()
        auth.signOut()
    }

    fun clearError() {
        _state.value = _state.value.copy(error = null, infoMessage = null)
    }

    private fun loadProfile(user: FirebaseUser) {
        _state.value = _state.value.copy(
            loading = true,
            signedIn = false,
            uid = user.uid,
            email = user.email.orEmpty(),
            error = null,
            infoMessage = null
        )

        profileListener?.remove()
        profileListener = firestore.collection("users").document(user.uid).addSnapshotListener { document, failure ->
            if (auth.currentUser?.uid != user.uid) return@addSnapshotListener
            val role = document?.getString("role")
            val companyId = document?.getString("companyId")
            val validProfile = failure == null && document?.exists() == true && when (role) {
                "company_admin" -> !companyId.isNullOrBlank()
                "driver", "dispatcher" -> !companyId.isNullOrBlank() && document.getString("membershipStatus") == "active"
                "super_admin" -> true
                else -> false
            }
            if (!validProfile) {
                stopAccountWork()
                auth.signOut()
                _state.value = AuthUiState(loading = false, error = message(R.string.profile_failed))
                return@addSnapshotListener
            }
            if (_state.value.signedIn && _state.value.companyId != companyId) stopAccountWork()
            _state.value = AuthUiState(loading = false, signedIn = true, uid = user.uid,
                email = user.email.orEmpty(), name = document?.getString("name").orEmpty(), companyId = companyId, role = role)
        }
    }

    private fun stopAccountWork() {
        val context = getApplication<Application>()
        context.stopService(Intent(context, LocationTrackingService::class.java))
        _state.value.uid?.let { SyncWorker.stop(context, SyncIdentity(it, _state.value.companyId.orEmpty())) }
    }

    override fun onCleared() {
        profileListener?.remove()
        auth.removeAuthStateListener(authListener)
        super.onCleared()
    }
}
