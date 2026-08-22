package com.pingpong.voice

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

class VoiceForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // ROBUSTNESS FIX (2026-08-14): starting a foreground service can throw
        // ForegroundServiceStartNotAllowedException (Android 12+) in edge cases outside
        // this app's control (e.g. OEM battery-optimization interference). Since this is
        // START_NOT_STICKY, an uncaught exception here would otherwise crash the process
        // hosting an active voice call — catch and stop cleanly instead so at worst the
        // notification/foreground promotion is lost rather than the whole app.
        try {
            startForegroundCompat()
        } catch (e: Exception) {
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun startForegroundCompat() {
        // ROBUSTNESS FIX (2026-08-14 Android production audit): getLaunchIntentForPackage()
        // can return null in rare cases (e.g. package manager cache inconsistency right
        // after an update). Passing a null Intent into PendingIntent.getActivity() throws
        // a NullPointerException, which would crash this foreground service — and crashing
        // a running FOREGROUND_SERVICE_TYPE_MICROPHONE service mid-call is exactly the kind
        // of "permanently stuck microphone" failure this audit is meant to catch. Fall back
        // to an explicit intent pointed straight at MainActivity, which always exists.
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?: Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification: Notification = NotificationCompat.Builder(this, PingPongApplication.CHANNEL_ID)
            .setContentTitle(getString(R.string.voice_notification_title))
            .setContentText(getString(R.string.voice_notification_text))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    }

    companion object {
        private const val NOTIFICATION_ID = 4102
    }
}
