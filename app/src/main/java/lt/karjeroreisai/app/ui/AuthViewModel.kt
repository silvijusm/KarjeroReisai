package lt.karjeroreisai.app.ui

import android.app.Application
import lt.karjeroreisai.app.R
import lt.karjeroreisai.app.AppLanguage
import androidx.lifecycle.AndroidViewModel
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
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
    val infoMessage: String? = null,
    /** Signed in, but not linked to any company yet (driver must enter a company code). */
    val needsCompany: Boolean = false,
    /** Driver / dispatcher membership: pending, active (null while loading or for owners). */
    val memberStatus: String? = null,
    val companyName: String = ""
) {
    val isMember: Boolean get() = role == "driver" || role == "dispatcher" || role == "loader"
    val isCompanyAdmin: Boolean get() = role == "company_admin" || role == "super_admin"
    val isManager: Boolean get() = isCompanyAdmin || (role == "dispatcher" && memberStatus == "active")
}

/** Bandomojo laikotarpio trukmė. Turi sutapti su firestore.rules (TRIAL_MS). */
const val TRIAL_DAYS = 30L

class AuthViewModel(app: Application) : AndroidViewModel(app) {
    private fun message(id: Int) = AppLanguage.wrap(getApplication()).getString(id)
    private var registering = false
    private val auth = FirebaseAuth.getInstance()
    private val firestore = FirebaseFirestore.getInstance()
    private val functions = FirebaseFunctions.getInstance("europe-west1")
    private var memberRegistration: ListenerRegistration? = null

    private val _state = MutableStateFlow(AuthUiState())
    val state: StateFlow<AuthUiState> = _state.asStateFlow()

    private val authListener = FirebaseAuth.AuthStateListener { firebaseAuth ->
        if (registering) return@AuthStateListener
        val user = firebaseAuth.currentUser
        if (user == null) {
            stopMemberListener()
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
                val trialEndsAt = now + TRIAL_DAYS * 24L * 60L * 60L * 1000L

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

    /** Driver: create an account and ask to join an existing company with its code. */
    fun registerDriver(name: String, code: String, email: String, password: String) {
        val cleanName = name.trim()
        val cleanEmail = email.trim()
        val cleanCode = code.trim()
        if (cleanName.isBlank() || cleanCode.isBlank() || cleanEmail.isBlank()) {
            _state.value = _state.value.copy(error = message(R.string.driver_registration_required))
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
                callJoin(cleanCode, cleanName) { error ->
                    registering = false
                    // The account exists even if the code was wrong: show the join screen with the error.
                    loadProfile(user, error)
                }
            }
            .addOnFailureListener {
                registering = false
                _state.value = AuthUiState(loading = false, error = message(R.string.registration_failed))
            }
    }

    /** Signed-in user without a company enters a company code. */
    fun joinCompany(code: String, name: String) {
        val user = auth.currentUser ?: return
        if (code.isBlank() || name.isBlank()) {
            _state.value = _state.value.copy(error = message(R.string.driver_registration_required))
            return
        }
        _state.value = _state.value.copy(loading = true, error = null, infoMessage = null)
        callJoin(code.trim(), name.trim()) { error -> loadProfile(user, error) }
    }

    fun cancelJoinRequest() {
        val user = auth.currentUser ?: return
        _state.value = _state.value.copy(loading = true, error = null)
        functions.getHttpsCallable("cancelJoin").call().addOnCompleteListener { result ->
            loadProfile(user, if (result.isSuccessful) null else message(R.string.action_failed))
        }
    }

    private fun callJoin(code: String, name: String, done: (String?) -> Unit) {
        functions.getHttpsCallable("joinCompany")
            .call(mapOf("code" to code, "name" to name))
            .addOnCompleteListener { result ->
                if (result.isSuccessful) { done(null); return@addOnCompleteListener }
                val id = when ((result.exception as? FirebaseFunctionsException)?.code) {
                    FirebaseFunctionsException.Code.NOT_FOUND -> R.string.join_wrong_code
                    FirebaseFunctionsException.Code.RESOURCE_EXHAUSTED -> R.string.join_too_many
                    FirebaseFunctionsException.Code.ALREADY_EXISTS -> R.string.join_already
                    FirebaseFunctionsException.Code.FAILED_PRECONDITION -> R.string.join_not_allowed
                    else -> R.string.join_failed
                }
                done(message(id))
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
        stopMemberListener()
        auth.signOut()
    }

    fun clearError() {
        _state.value = _state.value.copy(error = null, infoMessage = null)
    }

    private fun loadProfile(user: FirebaseUser, pendingError: String? = null) {
        stopMemberListener()
        _state.value = _state.value.copy(
            loading = true,
            signedIn = false,
            uid = user.uid,
            email = user.email.orEmpty(),
            error = null,
            infoMessage = null
        )

        firestore.collection("users").document(user.uid).get()
            .addOnSuccessListener { document ->
                if (auth.currentUser?.uid != user.uid) return@addOnSuccessListener
                if (!document.exists()) {
                    // A driver account that is not (or no longer) linked to a company.
                    _state.value = AuthUiState(
                        loading = false, signedIn = true, uid = user.uid,
                        email = user.email.orEmpty(), needsCompany = true, error = pendingError
                    )
                    return@addOnSuccessListener
                }
                val role = document.getString("role")
                val companyId = document.getString("companyId")
                val validProfile = when (role) {
                    "company_admin", "driver", "dispatcher", "loader" -> !companyId.isNullOrBlank()
                    "super_admin" -> true
                    else -> false
                }
                if (!validProfile) {
                    auth.signOut()
                    _state.value = AuthUiState(loading = false, error = message(R.string.profile_failed))
                    return@addOnSuccessListener
                }
                _state.value = AuthUiState(
                    loading = false,
                    signedIn = true,
                    uid = user.uid,
                    email = user.email.orEmpty(),
                    name = document.getString("name").orEmpty(),
                    companyId = companyId,
                    role = role,
                    error = pendingError
                )
                if (role == "driver" || role == "dispatcher" || role == "loader") listenMembership(user, companyId!!)
            }
            .addOnFailureListener {
                if (auth.currentUser?.uid != user.uid) return@addOnFailureListener
                auth.signOut()
                _state.value = AuthUiState(
                    loading = false,
                    signedIn = false,
                    error = message(R.string.profile_failed)
                )
            }
    }

    /** Follows approval / removal live, so the driver does not need to restart the app. */
    private fun listenMembership(user: FirebaseUser, companyId: String) {
        memberRegistration = firestore.collection("companies").document(companyId)
            .collection("members").document(user.uid)
            .addSnapshotListener { doc, failure ->
                if (auth.currentUser?.uid != user.uid) return@addSnapshotListener
                if (failure != null) return@addSnapshotListener // Offline: keep the last known state.
                val status = doc?.getString("status")
                if (status == "pending" || status == "active") {
                    // Role changes (driver <-> dispatcher) are applied by the server to both documents.
                    _state.value = _state.value.copy(
                        memberStatus = status,
                        role = doc.getString("role") ?: _state.value.role,
                        companyName = doc.getString("companyName").orEmpty()
                    )
                } else {
                    // Rejected, removed or cancelled: show the join screen.
                    stopMemberListener()
                    _state.value = _state.value.copy(
                        needsCompany = true, companyId = null, role = null, memberStatus = null, loading = false
                    )
                }
            }
    }

    private fun stopMemberListener() {
        memberRegistration?.remove()
        memberRegistration = null
    }

    override fun onCleared() {
        auth.removeAuthStateListener(authListener)
        stopMemberListener()
        super.onCleared()
    }
}
