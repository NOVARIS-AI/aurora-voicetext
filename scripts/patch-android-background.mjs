import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = process.cwd();
const javaDir = join(root, 'android/app/src/main/java/com/novaris/auroravoicetext');
await mkdir(javaDir, { recursive: true });

const plugin = `package com.novaris.auroravoicetext;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BackgroundTranscription")
public class BackgroundTranscriptionPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), TranscriptionForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
        else getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), TranscriptionForegroundService.class));
        call.resolve();
    }
}`;

const service = `package com.novaris.auroravoicetext;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public class TranscriptionForegroundService extends Service {
    private static final String CHANNEL_ID = "aurora_transcription";
    private static final int NOTIFICATION_ID = 4201;
    private PowerManager.WakeLock wakeLock;

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pending = launch == null ? null : PendingIntent.getActivity(this, 0, launch,
            Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT);
        builder.setContentTitle("AURORA VoiceText is working")
            .setContentText("Your transcription is processing. Return to the app to see progress.")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_PROGRESS);
        if (pending != null) builder.setContentIntent(pending);
        startForeground(NOTIFICATION_ID, builder.build());

        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager != null) {
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AURORA:Transcription");
            wakeLock.acquire(6L * 60L * 60L * 1000L);
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Transcription progress", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Keeps AURORA transcription active while processing audio.");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}`;

await writeFile(join(javaDir, 'BackgroundTranscriptionPlugin.java'), plugin);
await writeFile(join(javaDir, 'TranscriptionForegroundService.java'), service);

const manifestPath = join(root, 'android/app/src/main/AndroidManifest.xml');
let manifest = await readFile(manifestPath, 'utf8');
const permissions = [
  '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
  '    <uses-permission android:name="android.permission.WAKE_LOCK" />',
  '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'
];
for (const permission of permissions) {
  const name = permission.match(/android:name="([^"]+)"/)[1];
  if (!manifest.includes(name)) manifest = manifest.replace('<application', permission + '\\n    <application');
}
if (!manifest.includes('TranscriptionForegroundService')) {
  manifest = manifest.replace('</application>', '        <service android:name=".TranscriptionForegroundService" android:exported="false" android:foregroundServiceType="dataSync" />\\n    </application>');
}
await writeFile(manifestPath, manifest);

const activityPath = join(javaDir, 'MainActivity.java');
let activity = await readFile(activityPath, 'utf8');
if (!activity.includes('BackgroundTranscriptionPlugin')) {
  activity = activity.replace('import com.getcapacitor.BridgeActivity;', 'import com.getcapacitor.BridgeActivity;\\nimport android.os.Bundle;\\nimport com.novaris.auroravoicetext.BackgroundTranscriptionPlugin;');
  activity = activity.replace('public class MainActivity extends BridgeActivity {', 'public class MainActivity extends BridgeActivity {\\n    @Override\\n    public void onCreate(Bundle savedInstanceState) {\\n        registerPlugin(BackgroundTranscriptionPlugin.class);\\n        super.onCreate(savedInstanceState);\\n    }');
}
await writeFile(activityPath, activity);
console.log('Patched Android foreground transcription service.');
