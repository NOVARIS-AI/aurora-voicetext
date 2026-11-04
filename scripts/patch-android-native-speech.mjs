import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const javaDir = join(root, 'android/app/src/main/java/com/novaris/auroravoicetext');
const speechPlugin = `package com.novaris.auroravoicetext;

import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

@CapacitorPlugin(name = "NativeSpeech")
public class NativeSpeechPlugin extends Plugin {
    private static final String MODEL_NAME = "vosk-model-small-en-us-0.15";
    private static final String[] MODEL_URLS = new String[] {
        "https://huggingface.co/grimso/vosk-models/resolve/main/vosk-model-small-en-us-0.15.zip",
        "https://huggingface.co/rhasspy/vosk-models/resolve/main/en/vosk-model-small-en-us-0.15.zip",
        "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
    };
    private static final String MODEL_SHA256 = "30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelRequested = new AtomicBoolean(false);
    private static final Object MODEL_LOCK = new Object();
    private static Model sharedModel;

    @PluginMethod
    public void prepareModel(PluginCall call) {
        worker.execute(() -> {
            try {
                File modelDir = ensureModelInstalled();
                // Validate the model, then release it; do not hold roughly 300 MB of
                // native model memory idle between setup and the user's transcription.
                Model validation = new Model(modelDir.getAbsolutePath());
                validation.close();
                JSObject result = new JSObject();
                result.put("ready", true);
                result.put("model", MODEL_NAME);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not prepare native offline speech recognition: " + error.getMessage(), error);
            }
        });
    }

    private File ensureModelInstalled() throws Exception {
        File root = new File(getContext().getFilesDir(), "speech-models");
        if (!root.exists() && !root.mkdirs()) throw new IllegalStateException("Could not create private model storage.");
        File installed = new File(root, MODEL_NAME);
        if (new File(installed, "am/final.mdl").isFile() && new File(installed, "conf/model.conf").isFile()) return installed;
        if (root.getUsableSpace() < 180L * 1024L * 1024L) throw new IllegalStateException("At least 180 MB of free storage is needed to install the English model.");
        File archive = new File(root, MODEL_NAME + ".zip.part");
        File temporary = new File(root, MODEL_NAME + ".extracting");
        deleteRecursively(temporary);
        try {
            downloadModelArchive(archive);
            if (!temporary.mkdirs()) throw new IllegalStateException("Could not prepare model extraction folder.");
            try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(new java.io.FileInputStream(archive)))) {
                ZipEntry entry;
                byte[] buffer = new byte[64 * 1024];
                long extracted = 0;
                while ((entry = zip.getNextEntry()) != null) {
                    File destination = new File(temporary, entry.getName()).getCanonicalFile();
                    if (!destination.getPath().startsWith(temporary.getCanonicalPath() + File.separator)) throw new IllegalStateException("The model archive contains an invalid path.");
                    if (entry.isDirectory()) {
                        if (!destination.exists() && !destination.mkdirs()) throw new IllegalStateException("Could not create model folder.");
                    } else {
                        File parent = destination.getParentFile();
                        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IllegalStateException("Could not create model folder.");
                        try (BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(destination))) {
                            int count;
                            while ((count = zip.read(buffer)) != -1) {
                                extracted += count;
                                if (extracted > 500L * 1024L * 1024L) throw new IllegalStateException("Extracted model exceeded its safety limit.");
                                output.write(buffer, 0, count);
                            }
                        }
                    }
                    zip.closeEntry();
                }
            }
            File extractedModel = new File(temporary, MODEL_NAME);
            if (!new File(extractedModel, "am/final.mdl").isFile() || !new File(extractedModel, "conf/model.conf").isFile()) {
                throw new IllegalStateException("The archive did not contain a valid Vosk English model.");
            }
            deleteRecursively(installed);
            if (!extractedModel.renameTo(installed)) throw new IllegalStateException("Could not activate the downloaded speech model.");
            return installed;
        } finally {
            if (archive.exists()) archive.delete();
            deleteRecursively(temporary);
        }
    }


    private void downloadModelArchive(File archive) throws Exception {
        Exception lastFailure = null;
        for (String modelUrl : MODEL_URLS) {
            HttpURLConnection connection = null;
            try {
                archive.delete();
                connection = (HttpURLConnection) new URL(modelUrl).openConnection();
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(90000);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestProperty("User-Agent", "AURORA-VoiceText-Android");
                connection.setRequestProperty("Accept", "application/zip, application/octet-stream, */*");
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status + " from " + new URL(modelUrl).getHost());
                if (connection.getContentLengthLong() > 120L * 1024L * 1024L) throw new IllegalStateException("The model archive is larger than expected.");
                try (InputStream input = new BufferedInputStream(connection.getInputStream());
                     FileOutputStream output = new FileOutputStream(archive)) {
                    byte[] buffer = new byte[64 * 1024];
                    int count;
                    long received = 0;
                    while ((count = input.read(buffer)) != -1) {
                        received += count;
                        if (received > 120L * 1024L * 1024L) throw new IllegalStateException("The model download exceeded its safety limit.");
                        output.write(buffer, 0, count);
                    }
                    output.getFD().sync();
                }
                java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
                try (InputStream input = new java.io.FileInputStream(archive)) {
                    byte[] buffer = new byte[64 * 1024];
                    int count;
                    while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
                }
                StringBuilder actual = new StringBuilder();
                for (byte value : digest.digest()) actual.append(String.format(java.util.Locale.US, "%02x", value & 0xff));
                if (!MODEL_SHA256.equals(actual.toString())) throw new IllegalStateException("Downloaded model failed SHA-256 verification.");
                return;
            } catch (Exception error) {
                lastFailure = error;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        if (archive.exists()) archive.delete();
        throw new IllegalStateException("Could not download the offline English model from any mirror. Check internet/DNS and retry. Last error: " +
            (lastFailure == null ? "unknown download error" : lastFailure.getMessage()), lastFailure);
    }

    private void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }

    @PluginMethod
    public void transcribeSegment(PluginCall call) {
        cancelRequested.set(false);
        String suppliedPath = call.getString("path", "");
        double startSeconds = call.getDouble("startSeconds", -1.0);
        double durationSeconds = call.getDouble("durationSeconds", -1.0);
        worker.execute(() -> {
            Recognizer recognizer = null;
            try {
                if (cancelRequested.get()) throw new InterruptedException("Transcription cancelled.");
                File root = new File(getContext().getFilesDir(), "aurora-audio-imports").getCanonicalFile();
                Uri uri = Uri.parse(suppliedPath);
                String path = "file".equalsIgnoreCase(uri.getScheme()) ? uri.getPath() : suppliedPath;
                File source = new File(path).getCanonicalFile();
                if (!source.getPath().startsWith(root.getPath() + File.separator) || !source.isFile()) {
                    throw new IllegalArgumentException("The selected recording is no longer in AURORA storage.");
                }
                if (!Double.isFinite(startSeconds) || !Double.isFinite(durationSeconds) || startSeconds < 0 || durationSeconds <= 0 || durationSeconds > 90) {
                    throw new IllegalArgumentException("Invalid audio section requested.");
                }
                File modelDir = new File(new File(getContext().getFilesDir(), "speech-models"), MODEL_NAME);
                if (!new File(modelDir, "am/final.mdl").isFile()) throw new IllegalStateException("The native English model is not installed. Connect to the internet and tap Prepare offline engine first.");
                byte[] wav = NativeAudioFilesPlugin.decodePcmWavSection(source, startSeconds, durationSeconds);
                if (cancelRequested.get()) throw new InterruptedException("Transcription cancelled.");
                synchronized (MODEL_LOCK) {
                    if (sharedModel == null) sharedModel = new Model(modelDir.getAbsolutePath());
                    recognizer = new Recognizer(sharedModel, 16000.0f);
                }
                recognizer.setWords(true);
                StringBuilder text = new StringBuilder();
                JSONArray words = new JSONArray();
                int offset = 44;
                if (wav.length <= offset) throw new IllegalStateException("Android did not decode any speech audio.");
                while (offset < wav.length) {
                    if (cancelRequested.get()) throw new InterruptedException("Transcription cancelled.");
                    int count = Math.min(8000, wav.length - offset);
                    count -= count % 2;
                    if (count <= 0) break;
                    if (recognizer.acceptWaveForm(Arrays.copyOfRange(wav, offset, offset + count), count)) {
                        appendRecognitionResult(recognizer.getResult(), text, words);
                    }
                    offset += count;
                }
                appendRecognitionResult(recognizer.getFinalResult(), text, words);
                JSObject result = new JSObject();
                result.put("text", text.toString().trim());
                result.put("words", words);
                result.put("sampleRate", 16000);
                result.put("engine", "vosk-android");
                call.resolve(result);
            } catch (InterruptedException cancelled) {
                call.reject("Transcription cancelled. Completed sections are saved; select the same recording and retry to resume.");
            } catch (Exception error) {
                call.reject("Native offline recognition failed: " + error.getMessage(), error);
            } finally {
                if (recognizer != null) {
                    try { recognizer.close(); } catch (Exception ignored) { }
                }
            }
        });
    }

    private void appendRecognitionResult(String json, StringBuilder text, JSONArray words) throws Exception {
        JSONObject object = new JSONObject(json);
        String phrase = object.optString("text", "").trim();
        if (!phrase.isEmpty()) {
            if (text.length() > 0) text.append(' ');
            text.append(phrase);
        }
        JSONArray resultWords = object.optJSONArray("result");
        if (resultWords != null) for (int i = 0; i < resultWords.length(); i++) words.put(resultWords.getJSONObject(i));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelRequested.set(true);
        call.resolve();
    }

    @PluginMethod
    public void releaseModel(PluginCall call) {
        worker.execute(() -> {
            synchronized (MODEL_LOCK) {
                if (sharedModel != null) {
                    try { sharedModel.close(); } catch (Exception ignored) { }
                    sharedModel = null;
                }
            }
            call.resolve();
        });
    }
}`;

const speechPath = join(javaDir, 'NativeSpeechPlugin.java');
await writeFile(speechPath, speechPlugin);

const audioPath = join(javaDir, 'NativeAudioFilesPlugin.java');
let audioPlugin = await readFile(audioPath, 'utf8');
audioPlugin = audioPlugin.replace('private byte[] decodePcmWavSection(File file, double startSeconds, double durationSeconds) throws Exception {','static byte[] decodePcmWavSection(File file, double startSeconds, double durationSeconds) throws Exception {');
audioPlugin = audioPlugin.replace('private void writeIntLE(ByteArrayOutputStream output, int value) {','private static void writeIntLE(ByteArrayOutputStream output, int value) {');
audioPlugin = audioPlugin.replace('private void writeShortLE(ByteArrayOutputStream output, int value) {','private static void writeShortLE(ByteArrayOutputStream output, int value) {');
await writeFile(audioPath, audioPlugin);

const gradlePath = join(root, 'android/app/build.gradle');
let gradle = await readFile(gradlePath, 'utf8');
if (!gradle.includes('com.alphacephei:vosk-android')) {
  if (!/dependencies\s*\{/.test(gradle)) throw new Error('Could not find Android app dependencies block.');
  gradle = gradle.replace(/dependencies\s*\{/, match => match + "\n    implementation 'com.alphacephei:vosk-android:0.3.75@aar'\n    implementation 'net.java.dev.jna:jna:5.18.1@aar'");
}
await writeFile(gradlePath, gradle);

const activityPath = join(javaDir, 'MainActivity.java');
let activity = await readFile(activityPath, 'utf8');
if (!activity.includes('NativeSpeechPlugin')) {
  activity = activity.replace('import com.getcapacitor.BridgeActivity;', 'import com.getcapacitor.BridgeActivity;\nimport com.novaris.auroravoicetext.NativeSpeechPlugin;');
  activity = activity.replace('public class MainActivity extends BridgeActivity {', 'public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n        registerPlugin(NativeSpeechPlugin.class);\n        super.onCreate(savedInstanceState);\n    }');
}
await writeFile(activityPath, activity);
console.log('Installed native Vosk speech runtime, model manager, and Android Gradle dependency.');
