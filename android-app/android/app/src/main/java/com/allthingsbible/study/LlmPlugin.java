package com.allthingsbible.study;

import android.content.Intent;
import android.net.Uri;
import android.os.StatFs;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mediapipe.tasks.genai.llminference.LlmInference;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * On-device LLM via MediaPipe tasks-genai. The model file (.task / .litertlm,
 * e.g. Gemma) is imported once by the user and stored in the app's files dir.
 */
@CapacitorPlugin(name = "Llm")
public class LlmPlugin extends Plugin {
    private LlmInference llm;
    private LlmInferenceSession session;
    private volatile boolean generating = false;
    // the in-flight generation's future, so teardown can wait for it
    private volatile com.google.common.util.concurrent.ListenableFuture<String> inflight;

    // Extension matters: the engine picks its parser by suffix (.task = zip
    // bundle, .litertlm = newer container). Keep whichever exists.
    private File modelFile() {
        File lm = new File(getContext().getFilesDir(), "model.litertlm");
        if (lm.exists()) return lm;
        return new File(getContext().getFilesDir(), "model.task");
    }

    private File modelFileFor(byte[] head, int len) {
        boolean zip = len >= 2 && head[0] == 'P' && head[1] == 'K';
        return new File(getContext().getFilesDir(),
                        zip ? "model.task" : "model.litertlm");
    }

    // The import renames models to model.litertlm/.task, losing the original
    // name — but the JS needs it to pick the right chat template (Gemma 3n
    // vs Gemma 4 use different turn markers). Persist it beside the model.
    private File nameFile() {
        return new File(getContext().getFilesDir(), "model.origname.txt");
    }

    private String readOrigName() {
        try (java.io.BufferedReader r = new java.io.BufferedReader(
                new java.io.FileReader(nameFile()))) {
            return r.readLine();
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * Stop any running generation, then close the session and the engine —
     * in that order. Closing the engine under a live session is undefined
     * behaviour in the native library.
     */
    private synchronized void closeEngine() {
        LlmInferenceSession s = session;
        if (s != null && generating) {
            try { s.cancelGenerateResponseAsync(); } catch (Exception ignored) {}
            com.google.common.util.concurrent.ListenableFuture<String> f = inflight;
            if (f != null) {
                try { f.get(10, java.util.concurrent.TimeUnit.SECONDS); }
                catch (Exception ignored) {}
            }
        }
        generating = false;
        inflight = null;
        if (s != null) {
            try { s.close(); } catch (Exception ignored) {}
            session = null;
        }
        if (llm != null) {
            try { llm.close(); } catch (Exception ignored) {}
            llm = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        // don't let a runaway generation keep burning battery after the
        // activity is gone
        new Thread(this::closeEngine).start();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        File f = modelFile();
        r.put("hasModel", f.exists());
        r.put("modelBytes", f.exists() ? f.length() : 0);
        r.put("file", f.getName());
        r.put("origName", readOrigName());
        r.put("loaded", llm != null);
        call.resolve(r);
    }

    @PluginMethod
    public void importModel(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "onModelPicked");
    }

    // fill buf with at least `want` bytes (or to EOF); content-provider
    // streams may legally return a single byte per read()
    private static int readAtLeast(InputStream in, byte[] buf, int want) throws Exception {
        int got = 0;
        while (got < want) {
            int n = in.read(buf, got, buf.length - got);
            if (n < 0) break;
            got += n;
        }
        return got;
    }

    @ActivityCallback
    private void onModelPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK
                || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        String origName = "";
        long declaredSize = -1;
        try (android.database.Cursor c = getContext().getContentResolver()
                .query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(
                    android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) origName = c.getString(idx);
                int sidx = c.getColumnIndex(android.provider.OpenableColumns.SIZE);
                if (sidx >= 0 && !c.isNull(sidx)) declaredSize = c.getLong(sidx);
            }
        } catch (Exception ignored) {}
        final String fOrigName = origName;
        final long fSize = declaredSize;
        new Thread(() -> {
            File tmp = new File(getContext().getFilesDir(), "model.tmp");
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                if (in == null) throw new Exception("could not open file");
                if (fSize > 0) {
                    StatFs fs = new StatFs(getContext().getFilesDir().getAbsolutePath());
                    long free = fs.getAvailableBytes();
                    if (free < fSize + (64L << 20)) {
                        throw new Exception(String.format(
                            "not enough free space: need %d MB, have %d MB",
                            fSize >> 20, free >> 20));
                    }
                }
                byte[] buf = new byte[1 << 20];
                int first = readAtLeast(in, buf, 64);
                if (first <= 0) throw new Exception("empty file");
                File dest = modelFileFor(buf, first);
                long total = 0;
                int n = first;
                // copy to a temp file: the previous model stays usable until
                // the new one is completely on disk
                try (OutputStream out = new FileOutputStream(tmp)) {
                    while (n > 0) {
                        out.write(buf, 0, n);
                        total += n;
                        JSObject p = new JSObject();
                        p.put("copiedBytes", total);
                        notifyListeners("importProgress", p);
                        n = in.read(buf);
                    }
                }
                if (fSize > 0 && total != fSize) {
                    throw new Exception("short copy: " + total + " of " + fSize + " bytes");
                }
                closeEngine();
                new File(getContext().getFilesDir(), "model.task").delete();
                new File(getContext().getFilesDir(), "model.litertlm").delete();
                if (!tmp.renameTo(dest)) throw new Exception("could not move model into place");
                try (java.io.FileWriter w = new java.io.FileWriter(nameFile())) {
                    w.write(fOrigName == null ? "" : fOrigName);
                } catch (Exception ignored) {}
                JSObject r = new JSObject();
                r.put("hasModel", true);
                r.put("modelBytes", total);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("import failed: " + e.getMessage());
            } finally {
                tmp.delete();
            }
        }).start();
    }

    @PluginMethod
    public void loadModel(PluginCall call) {
        File f = modelFile();
        if (!f.exists()) {
            call.reject("no model imported");
            return;
        }
        int maxTokens = call.getInt("maxTokens", 2048);
        new Thread(() -> {
            try {
                closeEngine();
                LlmInference.LlmInferenceOptions options =
                    LlmInference.LlmInferenceOptions.builder()
                        .setModelPath(f.getAbsolutePath())
                        .setMaxTokens(maxTokens)
                        .build();
                llm = LlmInference.createFromOptions(getContext(), options);
                JSObject r = new JSObject();
                r.put("loaded", true);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("load failed: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void countTokens(PluginCall call) {
        if (llm == null) {
            call.reject("model not loaded");
            return;
        }
        try {
            int n = llm.sizeInTokens(call.getString("text", ""));
            JSObject r = new JSObject();
            r.put("tokens", n);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("count failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void generate(PluginCall call) {
        if (llm == null) {
            call.reject("model not loaded");
            return;
        }
        if (generating) {
            call.reject("busy");
            return;
        }
        String prompt = call.getString("prompt", "");
        Float temp = call.getFloat("temperature", 0.2f);
        generating = true;
        final AtomicBoolean settled = new AtomicBoolean(false);
        try {
            // explicit session so runaway generations can be CANCELLED —
            // the engine does not stop at <end_of_turn> on its own
            if (session != null) {
                try { session.close(); } catch (Exception ignored) {}
                session = null;
            }
            session = LlmInferenceSession.createFromOptions(llm,
                LlmInferenceSession.LlmInferenceSessionOptions.builder()
                    .setTopK(40)
                    .setTemperature(temp)
                    .build());
            session.addQueryChunk(prompt);
            com.google.common.util.concurrent.ListenableFuture<String> fut =
                session.generateResponseAsync((partial, done) -> {
                    JSObject ev = new JSObject();
                    ev.put("text", partial);
                    ev.put("done", done);
                    notifyListeners("token", ev);
                    if (done && settled.compareAndSet(false, true)) {
                        generating = false;
                        inflight = null;
                        JSObject r = new JSObject();
                        r.put("done", true);
                        call.resolve(r);
                    }
                });
            inflight = fut;
            // engine failures (e.g. prefill overflow) surface on the future,
            // not the progress callback — reject so JS can retry smaller.
            // A cancelled generation may complete the future WITHOUT a final
            // done callback: settle here too so `generating` never sticks.
            fut.addListener(() -> {
                try {
                    fut.get();
                    if (settled.compareAndSet(false, true)) {
                        generating = false;
                        inflight = null;
                        JSObject r = new JSObject();
                        r.put("done", true);
                        call.resolve(r);
                    }
                } catch (Exception e) {
                    if (settled.compareAndSet(false, true)) {
                        generating = false;
                        inflight = null;
                        call.reject("engine: " + e.getMessage());
                    }
                }
            }, ContextCompat.getMainExecutor(getContext()));
        } catch (Exception e) {
            generating = false;
            inflight = null;
            call.reject("generate failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            if (session != null) {
                session.cancelGenerateResponseAsync();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("stop failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void removeModel(PluginCall call) {
        new Thread(() -> {
            closeEngine();
            boolean ok = !modelFile().exists() || modelFile().delete();
            nameFile().delete();
            JSObject r = new JSObject();
            r.put("removed", ok);
            call.resolve(r);
        }).start();
    }
}
