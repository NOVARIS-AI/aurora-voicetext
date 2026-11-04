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
    public void update(PluginCall call) {
        String message = call.getString("message", "Transcription is processing.");
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(getContext(), "aurora_transcription")
            : new Notification.Builder(getContext());
        builder.setContentTitle("AURORA VoiceText")
            .setContentText(message.length() > 120 ? message.substring(0, 117) + "..." : message)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_PROGRESS);
        NotificationManager manager = (NotificationManager) getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(4201, builder.build());
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), TranscriptionForegroundService.class));
        call.resolve();
    }
}`;


const nativeAudioPlugin = `package com.novaris.auroravoicetext;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

@CapacitorPlugin(name = "NativeAudioFiles")
public class NativeAudioFilesPlugin extends Plugin {
    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "audioPicked");
    }

    @ActivityCallback
    private void audioPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Audio selection was cancelled.");
            return;
        }
        Intent data = result.getData();
        ArrayList<Uri> selected = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) selected.add(clip.getItemAt(i).getUri());
        } else if (data.getData() != null) {
            selected.add(data.getData());
        }
        if (selected.isEmpty()) {
            call.reject("No audio file was selected.");
            return;
        }
        JSArray files = new JSArray();
        File directory = new File(getContext().getCacheDir(), "aurora-audio-imports");
        if (!directory.exists() && !directory.mkdirs()) {
            call.reject("Could not prepare private audio storage.");
            return;
        }
        try {
            int index = 0;
            for (Uri uri : selected) {
                String name = queryName(uri);
                String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
                if (safe.isEmpty()) safe = "recording-" + index + ".audio";
                File destination = new File(directory, System.currentTimeMillis() + "-" + index + "-" + safe);
                try (InputStream input = getContext().getContentResolver().openInputStream(uri);
                     FileOutputStream output = new FileOutputStream(destination)) {
                    if (input == null) throw new IllegalStateException("Android could not open " + name);
                    byte[] buffer = new byte[64 * 1024];
                    int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                }
                JSObject item = new JSObject();
                item.put("path", "file://" + destination.getAbsolutePath());
                item.put("name", name);
                item.put("size", destination.length());
                item.put("mimeType", getContext().getContentResolver().getType(uri));
                files.put(item);
                index++;
            }
            JSObject response = new JSObject();
            response.put("files", files);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Could not import the selected audio: " + error.getMessage(), error);
        }
    }

    private String queryName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) { }
        return "recording.audio";
    }
}

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
            .setContentText("Keep AURORA open while transcription runs. Return to the app to see progress.")
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

    // This service holds a foreground notification and CPU wake lock only. It does not
    // execute the WebView transcription engine independently if Android kills the app.
    // Do not resurrect a stale notification after the app process has gone away.
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String message = intent == null ? null : intent.getStringExtra("status_message");
        if (message != null && !message.trim().isEmpty()) {
            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            PendingIntent pending = launch == null ? null : PendingIntent.getActivity(this, 0, launch,
                Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT);
            builder.setContentTitle("AURORA VoiceText")
                .setContentText(message.length() > 120 ? message.substring(0, 117) + "..." : message)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_PROGRESS);
            if (pending != null) builder.setContentIntent(pending);
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, builder.build());
        }
        return START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}`;

await writeFile(join(javaDir, 'BackgroundTranscriptionPlugin.java'), plugin);
await writeFile(join(javaDir, 'NativeAudioFilesPlugin.java'), nativeAudioPlugin);
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
  if (!manifest.includes(name)) manifest = manifest.replace('<application', permission + '\n    <application');
}
if (!manifest.includes('TranscriptionForegroundService')) {
  manifest = manifest.replace('</application>', '        <service android:name=".TranscriptionForegroundService" android:exported="false" android:foregroundServiceType="dataSync" />\n    </application>');
}
await writeFile(manifestPath, manifest);

const activityPath = join(javaDir, 'MainActivity.java');
let activity = await readFile(activityPath, 'utf8');
if (!activity.includes('BackgroundTranscriptionPlugin')) {
  activity = activity.replace('import com.getcapacitor.BridgeActivity;', 'import com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;\nimport com.novaris.auroravoicetext.BackgroundTranscriptionPlugin;\nimport com.novaris.auroravoicetext.NativeAudioFilesPlugin;');
  activity = activity.replace('public class MainActivity extends BridgeActivity {', 'public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(BackgroundTranscriptionPlugin.class);\n        registerPlugin(NativeAudioFilesPlugin.class);\n        super.onCreate(savedInstanceState);\n    }');
}
await writeFile(activityPath, activity);
console.log('Patched Android foreground transcription service.');
