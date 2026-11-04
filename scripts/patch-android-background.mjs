import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = process.cwd();
const javaDir = join(root, 'android/app/src/main/java/com/novaris/auroravoicetext');
await mkdir(javaDir, { recursive: true });

const plugin = `package com.novaris.auroravoicetext;

import android.content.Intent;
import android.app.Notification;
import android.app.NotificationManager;
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
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.io.ByteArrayOutputStream;
import android.util.Base64;
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
import java.security.MessageDigest;

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
        ArrayList<File> createdImports = new ArrayList<>();
        long batchBytes = 0L;
        final long maxFileBytes = 256L * 1024L * 1024L;
        final long maxBatchBytes = 512L * 1024L * 1024L;
        final long reserveBytes = 256L * 1024L * 1024L;
        File directory = new File(getContext().getFilesDir(), "aurora-audio-imports");
        if (!directory.exists() && !directory.mkdirs()) {
            call.reject("Could not prepare private audio storage.");
            return;
        }
        prunePrivateAudioImports(directory);
        try {
            int index = 0;
            for (Uri uri : selected) {
                String name = queryName(uri);
                String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
                if (safe.isEmpty()) safe = "recording-" + index + ".audio";
                File destination = new File(directory, System.currentTimeMillis() + "-" + index + "-" + safe);
                createdImports.add(destination);
                long availableBytes = directory.getUsableSpace();
                if (availableBytes < reserveBytes) throw new IllegalStateException("Not enough free storage. Keep at least 256 MB free before importing audio.");
                MessageDigest contentDigest = MessageDigest.getInstance("SHA-256");
                try (InputStream input = getContext().getContentResolver().openInputStream(uri);
                     FileOutputStream output = new FileOutputStream(destination)) {
                    if (input == null) throw new IllegalStateException("Android could not open " + name);
                    byte[] buffer = new byte[64 * 1024];
                    int count;
                    long fileBytes = 0L;
                    while ((count = input.read(buffer)) != -1) {
                        fileBytes += count;
                        batchBytes += count;
                        if (fileBytes > maxFileBytes) throw new IllegalStateException("This audio file exceeds the 256 MB import limit. Split it into smaller recordings and try again.");
                        if (batchBytes > maxBatchBytes) throw new IllegalStateException("This selection exceeds the 512 MB total import limit. Import fewer files at a time.");
                        if (fileBytes + reserveBytes > directory.getUsableSpace()) throw new IllegalStateException("Android is running low on storage. Free space and try again.");
                        output.write(buffer, 0, count);
                        contentDigest.update(buffer, 0, count);
                    }
                }
                String contentHash = toHex(contentDigest.digest());
                JSObject item = new JSObject();
                item.put("path", "file://" + destination.getAbsolutePath());
                item.put("contentHash", contentHash);
                item.put("name", name);
                item.put("size", destination.length());
                item.put("mimeType", getContext().getContentResolver().getType(uri));
                item.put("durationMs", readDurationMs(destination));
                JSObject audioInfo = readAudioInfo(destination);
                item.put("audioInfo", audioInfo);
                files.put(item);
                index++;
            }
            JSObject response = new JSObject();
            response.put("files", files);
            call.resolve(response);
        } catch (Exception error) {
            for (File imported : createdImports) {
                if (imported.exists()) imported.delete();
            }
            call.reject("Could not import the selected audio: " + error.getMessage(), error);
        }
    }

    private String toHex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return value.toString();
    }

    // Private imports are temporary working copies, not permanent archival storage.
    // Remove copies older than seven days and cap this cache at 1 GiB, oldest first.
    private void prunePrivateAudioImports(File directory) {
        File[] entries = directory.listFiles();
        if (entries == null) return;
        final long now = System.currentTimeMillis();
        final long maxAge = 7L * 24L * 60L * 60L * 1000L;
        final long maxBytes = 1024L * 1024L * 1024L;
        java.util.Arrays.sort(entries, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        long total = 0L;
        for (File entry : entries) {
            if (!entry.isFile()) continue;
            if (now - entry.lastModified() > maxAge) entry.delete();
            else total += entry.length();
        }
        entries = directory.listFiles();
        if (entries == null || total <= maxBytes) return;
        java.util.Arrays.sort(entries, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File entry : entries) {
            if (total <= maxBytes) break;
            if (entry.isFile()) { long size = entry.length(); if (entry.delete()) total -= size; }
        }
    }

    @PluginMethod
    public void decodeSegment(PluginCall call) {
        String path = call.getString("path", "");
        double startSeconds = call.getDouble("startSeconds", -1.0);
        double durationSeconds = call.getDouble("durationSeconds", -1.0);
        try {
            File root = new File(getContext().getFilesDir(), "aurora-audio-imports").getCanonicalFile();
            Uri suppliedUri = Uri.parse(path);
            String sourcePath = "file".equalsIgnoreCase(suppliedUri.getScheme()) ? suppliedUri.getPath() : path;
            File source = new File(sourcePath).getCanonicalFile();
            if (!source.getPath().startsWith(root.getPath() + File.separator) || !source.isFile()) {
                call.reject("The selected audio is no longer available in AURORA storage.");
                return;
            }
            if (!Double.isFinite(startSeconds) || !Double.isFinite(durationSeconds) ||
                startSeconds < 0 || durationSeconds <= 0 || durationSeconds > 90) {
                call.reject("Invalid audio section requested.");
                return;
            }
            byte[] wav = decodePcmWavSection(source, startSeconds, durationSeconds);
            JSObject result = new JSObject();
            result.put("wavBase64", Base64.encodeToString(wav, Base64.NO_WRAP));
            result.put("sampleRate", 16000);
            result.put("channels", 1);
            result.put("durationSeconds", durationSeconds);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Android could not decode this audio section: " + error.getMessage(), error);
        }
    }

    // Decode only the requested section with Android MediaCodec, downmix to mono,
    // resample to 16 kHz, and return a small WAV payload for the speech engine.
    static byte[] decodePcmWavSection(File file, double startSeconds, double durationSeconds) throws Exception {
        final long startUs = (long) (startSeconds * 1000000.0);
        final long endUs = (long) ((startSeconds + durationSeconds) * 1000000.0);
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec decoder = null;
        ByteArrayOutputStream monoPcm = new ByteArrayOutputStream();
        int sourceRate = 0;
        int sourceChannels = 0;
        boolean inputDone = false;
        boolean outputDone = false;
        try {
            extractor.setDataSource(file.getAbsolutePath());
            int audioTrack = -1;
            MediaFormat inputFormat = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat candidate = extractor.getTrackFormat(i);
                String mime = candidate.containsKey(MediaFormat.KEY_MIME) ? candidate.getString(MediaFormat.KEY_MIME) : null;
                if (mime != null && mime.startsWith("audio/")) {
                    audioTrack = i;
                    inputFormat = candidate;
                    break;
                }
            }
            if (audioTrack < 0 || inputFormat == null) throw new IllegalArgumentException("No supported audio track was found.");
            String mime = inputFormat.getString(MediaFormat.KEY_MIME);
            extractor.selectTrack(audioTrack);
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            decoder = MediaCodec.createDecoderByType(mime);
            decoder.configure(inputFormat, null, null, 0);
            decoder.start();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            while (!outputDone) {
                if (!inputDone) {
                    int inputIndex = decoder.dequeueInputBuffer(10000);
                    if (inputIndex >= 0) {
                        ByteBuffer input = decoder.getInputBuffer(inputIndex);
                        if (input == null) throw new IllegalStateException("Audio decoder input buffer is unavailable.");
                        input.clear();
                        int size = extractor.readSampleData(input, 0);
                        if (size < 0) {
                            decoder.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            long presentationTime = extractor.getSampleTime();
                            if (presentationTime >= endUs) {
                                decoder.queueInputBuffer(inputIndex, 0, 0, presentationTime, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                                inputDone = true;
                            } else {
                                decoder.queueInputBuffer(inputIndex, 0, size, presentationTime, 0);
                                extractor.advance();
                            }
                        }
                    }
                }
                int outputIndex = decoder.dequeueOutputBuffer(info, 10000);
                if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat outputFormat = decoder.getOutputFormat();
                    sourceRate = outputFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 0;
                    sourceChannels = outputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 0;
                } else if (outputIndex >= 0) {
                    ByteBuffer output = decoder.getOutputBuffer(outputIndex);
                    if (output != null && info.size > 0) {
                        MediaFormat format = decoder.getOutputFormat();
                        int rate = format.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? format.getInteger(MediaFormat.KEY_SAMPLE_RATE) : sourceRate;
                        int channels = format.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : sourceChannels;
                        if (rate <= 0 || channels <= 0) throw new IllegalStateException("Audio decoder returned invalid PCM metadata.");
                        sourceRate = rate;
                        sourceChannels = channels;
                        output.order(ByteOrder.LITTLE_ENDIAN);
                        output.position(info.offset);
                        output.limit(info.offset + info.size);
                        int bytesPerFrame = channels * 2;
                        int frames = info.size / bytesPerFrame;
                        for (int frame = 0; frame < frames; frame++) {
                            long frameTimeUs = info.presentationTimeUs + ((long) frame * 1000000L / rate);
                            if (frameTimeUs < startUs || frameTimeUs >= endUs) continue;
                            int sum = 0;
                            int frameOffset = info.offset + frame * bytesPerFrame;
                            for (int channel = 0; channel < channels; channel++) sum += output.getShort(frameOffset + channel * 2);
                            short mono = (short) (sum / channels);
                            monoPcm.write(mono & 0xff);
                            monoPcm.write((mono >> 8) & 0xff);
                        }
                    }
                    boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    decoder.releaseOutputBuffer(outputIndex, false);
                    if (eos) outputDone = true;
                }
            }
            if (sourceRate <= 0 || monoPcm.size() < 2) throw new IllegalArgumentException("No decodable audio samples were found in this section.");
            byte[] source = monoPcm.toByteArray();
            int sourceSamples = source.length / 2;
            int targetSamples = Math.max(1, (int) ((long) sourceSamples * 16000L / sourceRate));
            ByteArrayOutputStream pcm16k = new ByteArrayOutputStream(targetSamples * 2);
            for (int i = 0; i < targetSamples; i++) {
                double position = (double) i * sourceRate / 16000.0;
                int left = Math.min(sourceSamples - 1, (int) position);
                int right = Math.min(sourceSamples - 1, left + 1);
                double fraction = position - left;
                int a = (short) ((source[left * 2] & 0xff) | (source[left * 2 + 1] << 8));
                int b = (short) ((source[right * 2] & 0xff) | (source[right * 2 + 1] << 8));
                short sample = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, Math.round(a + (b - a) * fraction)));
                pcm16k.write(sample & 0xff);
                pcm16k.write((sample >> 8) & 0xff);
            }
            byte[] pcm = pcm16k.toByteArray();
            ByteArrayOutputStream wav = new ByteArrayOutputStream(pcm.length + 44);
            wav.write(new byte[] { 'R','I','F','F' });
            writeIntLE(wav, 36 + pcm.length);
            wav.write(new byte[] { 'W','A','V','E','f','m','t',' ' });
            writeIntLE(wav, 16);
            writeShortLE(wav, 1);
            writeShortLE(wav, 1);
            writeIntLE(wav, 16000);
            writeIntLE(wav, 32000);
            writeShortLE(wav, 2);
            writeShortLE(wav, 16);
            wav.write(new byte[] { 'd','a','t','a' });
            writeIntLE(wav, pcm.length);
            wav.write(pcm);
            return wav.toByteArray();
        } finally {
            if (decoder != null) {
                try { decoder.stop(); } catch (Exception ignored) { }
                try { decoder.release(); } catch (Exception ignored) { }
            }
            extractor.release();
        }
    }

    private static void writeIntLE(ByteArrayOutputStream output, int value) {
        output.write(value & 0xff);
        output.write((value >> 8) & 0xff);
        output.write((value >> 16) & 0xff);
        output.write((value >> 24) & 0xff);
    }

    private static void writeShortLE(ByteArrayOutputStream output, int value) {
        output.write(value & 0xff);
        output.write((value >> 8) & 0xff);
    }

    private long readDurationMs(File file) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(file.getAbsolutePath());
            String value = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (value != null) {
                long duration = Long.parseLong(value);
                if (duration > 0) return duration;
            }
        } catch (Exception ignored) {
            // Try MediaExtractor metadata below for formats the retriever cannot inspect.
        } finally {
            try { retriever.release(); } catch (Exception ignored) { }
        }
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(file.getAbsolutePath());
            long longestDurationUs = 0L;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat format = extractor.getTrackFormat(i);
                if (format.containsKey(MediaFormat.KEY_DURATION)) {
                    longestDurationUs = Math.max(longestDurationUs, format.getLong(MediaFormat.KEY_DURATION));
                }
            }
            return longestDurationUs > 0 ? longestDurationUs / 1000L : 0L;
        } catch (Exception ignored) {
            return 0L;
        } finally {
            extractor.release();
        }
    }

    private JSObject readAudioInfo(File file) {
        JSObject info = new JSObject();
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(file.getAbsolutePath());
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat format = extractor.getTrackFormat(i);
                String mime = format.containsKey(MediaFormat.KEY_MIME) ? format.getString(MediaFormat.KEY_MIME) : null;
                if (mime == null || !mime.startsWith("audio/")) continue;
                info.put("codec", mime);
                if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) info.put("sampleRate", format.getInteger(MediaFormat.KEY_SAMPLE_RATE));
                if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) info.put("channels", format.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
                break;
            }
        } catch (Exception ignored) {
            info.put("codec", "unknown");
        } finally {
            extractor.release();
        }
        return info;
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

`;

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
  activity = activity.replace('import com.getcapacitor.BridgeActivity;', 'import com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;\nimport com.novaris.auroravoicetext.BackgroundTranscriptionPlugin;\nimport com.novaris.auroravoicetext.NativeAudioFilesPlugin;\nimport com.novaris.auroravoicetext.NativeSpeechPlugin;');
  activity = activity.replace('public class MainActivity extends BridgeActivity {', 'public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(BackgroundTranscriptionPlugin.class);\n        registerPlugin(NativeAudioFilesPlugin.class);\n        registerPlugin(NativeSpeechPlugin.class);\n        super.onCreate(savedInstanceState);\n    }');
}
await writeFile(activityPath, activity);
console.log('Patched Android foreground transcription and native Vosk speech recognition.');
