package com.dealerdoor.app.ui

import androidx.activity.compose.LocalActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MapsHomeWork
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.dealerdoor.app.R
import com.dealerdoor.app.core.Auth
import com.dealerdoor.app.core.AuthState
import com.dealerdoor.app.core.Role
import kotlinx.coroutines.launch

@Composable
fun RootScreen() {
    when (val state = Auth.state.collectAsState().value) {
        AuthState.Loading -> Loading()
        AuthState.SignedOut -> LoginScreen()
        AuthState.Locked -> LockScreen()
        is AuthState.SignedIn -> if (state.me.role == Role.customer) CustomerHome() else CoworkerHome()
    }
}

@Composable
fun LoginScreen() {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var usePassword by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val checkEmail = stringResource(R.string.check_email_link)

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Icons.Filled.MapsHomeWork, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 48.dp).size(44.dp))
        Text(stringResource(R.string.welcome), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(stringResource(R.string.welcome_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text(stringResource(R.string.email)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth().testTag("login.email"),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.sign_in_with_password), modifier = Modifier.weight(1f))
            Switch(checked = usePassword, onCheckedChange = { usePassword = it }, modifier = Modifier.testTag("login.usePassword"))
        }
        if (usePassword) {
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text(stringResource(R.string.password)) },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Button(
            onClick = {
                scope.launch {
                    busy = true
                    error = null
                    try {
                        val signedIn = Auth.login(email.trim().lowercase(), if (usePassword) password else null)
                        if (!signedIn) message = checkEmail
                    } catch (e: Exception) {
                        error = e.message
                    } finally {
                        busy = false
                    }
                }
            },
            enabled = !busy && email.contains("@"),
            modifier = Modifier.fillMaxWidth().testTag("login.submit"),
        ) {
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else Text(stringResource(if (usePassword) R.string.sign_in else R.string.email_me_link))
        }
        message?.let { Text(it) }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("login.error")) }
    }
}

@Composable
fun LockScreen() {
    val activity = LocalActivity.current as FragmentActivity
    val title = stringResource(R.string.unlock_app)

    fun prompt() {
        val authenticators = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        // No fingerprint, face or screen lock set up: nothing to unlock with, so just continue.
        if (BiometricManager.from(activity).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            Auth.unlocked()
            return
        }
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = Auth.unlocked()
        }
        val info = BiometricPrompt.PromptInfo.Builder().setTitle(title).setAllowedAuthenticators(authenticators).build()
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info)
    }

    LaunchedEffect(Unit) { prompt() }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(48.dp))
        Text(stringResource(R.string.locked), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Button(onClick = ::prompt) { Text(stringResource(R.string.unlock)) }
        TextButton(onClick = Auth::signOut) { Text(stringResource(R.string.use_different_account)) }
    }
}
