package com.allthingsbible.study;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONObject;

/**
 * Device text-to-speech.
 *
 * Two uses:
 *  - pronunciation of single lexicon words: voices() / speak() (unchanged API)
 *  - chapter read-aloud: speakQueue() / pause() / resume() / stopAll()
 *
 * Read-aloud contract (events via notifyListeners):
 *   speakQueue({items: [{id, text, lang}], rate})
 *       queues every item (QUEUE_FLUSH for the first, QUEUE_ADD after), one
 *       language per item (BCP-47, e.g. "en-US", "el-GR", "he-IL", "la").
 *       Rejects "voice unavailable: <lang>" BEFORE speaking anything if any
 *       item's language has no voice. Items whose text is blank are skipped
 *       (no events for them). Items longer than getMaxSpeechInputLength()
 *       are split into sentence chunks that share the item id.
 *   pause()    Android TTS cannot pause: stops the engine and remembers the
 *              item being read; resume() re-queues from that item (the
 *              interrupted item restarts from its beginning).
 *   resume()   resolves {resumed:false} when nothing was paused.
 *   stopAll()  stops and forgets the queue (no ttsFinished is emitted).
 *   Events:    ttsStart {id}            an item began (once per item)
 *              ttsDone {id}             an item finished normally
 *              ttsError {id, message}   an item failed (engine skips on)
 *              ttsFinished {}           the last queued item ended
 * Callbacks arrive on a binder thread; every queue mutation is guarded by
 * `lock`, and a generation counter discards callbacks from a flushed queue.
 */
@CapacitorPlugin(name = "Tts")
public class TtsPlugin extends Plugin {
    private TextToSpeech tts;
    // set on the main thread in onInit, read on the plugin thread
    private volatile boolean ready = false;

    // ---- read-aloud queue state (guarded by lock) ----
    private final Object lock = new Object();
    private static final class Item {
        final String id;
        final String lang;
        final List<String> chunks;
        Item(String id, String lang, List<String> chunks) {
            this.id = id; this.lang = lang; this.chunks = chunks;
        }
    }
    private List<Item> queue = new ArrayList<>();
    private int generation = 0;     // bumped on every flush/stop
    private int resumeIndex = -1;   // item index to restart from after pause
    private boolean paused = false;
    private float queueRate = 0.9f;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(),
            status -> ready = status == TextToSpeech.SUCCESS);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) {
                Ref r = parse(utteranceId);
                if (r == null) return;
                if (r.chunk == 0) emit("ttsStart", r.id, null);
            }
            @Override public void onDone(String utteranceId) {
                Ref r = parse(utteranceId);
                if (r == null) return;
                if (r.lastChunk) emit("ttsDone", r.id, null);
                if (r.lastChunk && r.lastItem) finished(r.gen);
            }
            @Override public void onError(String utteranceId, int errorCode) {
                Ref r = parse(utteranceId);
                if (r == null) return;
                emit("ttsError", r.id, "tts error " + errorCode);
                if (r.lastChunk && r.lastItem) finished(r.gen);
            }
            @SuppressWarnings("deprecation")
            @Override public void onError(String utteranceId) {
                onError(utteranceId, TextToSpeech.ERROR);
            }
            @Override public void onStop(String utteranceId, boolean interrupted) {
                // stop()/pause()/flush: the queue generation was bumped
                // before the engine was stopped, so parse() already
                // discards this callback — nothing to do
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lock) {
            generation++;
            queue = new ArrayList<>();
            paused = false;
            resumeIndex = -1;
        }
        if (tts != null) {
            try { tts.stop(); } catch (Exception ignored) {}
            try { tts.shutdown(); } catch (Exception ignored) {}
            tts = null;
            ready = false;
        }
    }

    // ------------------------------------------------------------ voices()
    private boolean langAvailable(String tag) {
        try {
            return tts.isLanguageAvailable(Locale.forLanguageTag(tag))
                >= TextToSpeech.LANG_AVAILABLE;
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void voices(PluginCall call) {
        JSObject r = new JSObject();
        // `ready:false` = the engine is still starting: the JS must not cache
        // this answer as "no voices on this device"
        r.put("ready", ready);
        String[] langs = {"el", "he", "en", "la", "syr"};
        for (String l : langs) r.put(l, ready && langAvailable(l));
        call.resolve(r);
    }

    // ------------------------------------------------------------- speak()
    @PluginMethod
    public void speak(PluginCall call) {
        if (!ready) {
            call.reject("tts not ready");
            return;
        }
        String text = call.getString("text", "");
        String lang = call.getString("lang", "en");
        Float rate = call.getFloat("rate", 0.75f);
        int avail = tts.setLanguage(Locale.forLanguageTag(lang));
        if (avail < TextToSpeech.LANG_AVAILABLE) {
            call.reject("voice unavailable: " + lang);
            return;
        }
        // a word lookup while a chapter is playing takes over: forget the
        // chapter queue so its callbacks (from the flush) are ignored
        synchronized (lock) {
            generation++;
            queue = new ArrayList<>();
            paused = false;
            resumeIndex = -1;
        }
        tts.setSpeechRate(rate);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "atb-tts");
        call.resolve();
    }

    // -------------------------------------------------------- speakQueue()
    @PluginMethod
    public void speakQueue(PluginCall call) {
        if (!ready) {
            call.reject("tts not ready");
            return;
        }
        JSArray arr = call.getArray("items");
        Float rate = call.getFloat("rate", 0.9f);
        List<Item> items = new ArrayList<>();
        int max = TextToSpeech.getMaxSpeechInputLength();
        try {
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.getJSONObject(i);
                    String text = o.optString("text", "").trim();
                    if (text.isEmpty()) continue;
                    items.add(new Item(o.optString("id", String.valueOf(i)),
                                       o.optString("lang", "en"),
                                       chunk(text, max)));
                }
            }
        } catch (Exception e) {
            call.reject("bad items: " + e.getMessage());
            return;
        }
        // every language must have a voice before anything is spoken
        List<String> checked = new ArrayList<>();
        for (Item it : items) {
            if (checked.contains(it.lang)) continue;
            if (!langAvailable(it.lang)) {
                call.reject("voice unavailable: " + it.lang);
                return;
            }
            checked.add(it.lang);
        }
        synchronized (lock) {
            queue = items;
            queueRate = rate;
            paused = false;
            resumeIndex = -1;
        }
        JSObject r = new JSObject();
        r.put("count", items.size());
        if (items.isEmpty()) {
            // nothing to say: tell the JS the queue is over right away
            call.resolve(r);
            notifyListeners("ttsFinished", new JSObject());
            return;
        }
        enqueueFrom(0);
        call.resolve(r);
    }

    @PluginMethod
    public void pause(PluginCall call) {
        int idx;
        synchronized (lock) {
            if (queue.isEmpty() || paused) {
                JSObject r = new JSObject();
                r.put("paused", paused);
                call.resolve(r);
                return;
            }
            idx = currentIndex < 0 ? 0 : currentIndex;
            generation++;          // discard callbacks from the stop below
            paused = true;
            resumeIndex = idx;
        }
        if (tts != null) try { tts.stop(); } catch (Exception ignored) {}
        JSObject r = new JSObject();
        r.put("paused", true);
        r.put("index", idx);
        call.resolve(r);
    }

    @PluginMethod
    public void resume(PluginCall call) {
        if (!ready) {
            call.reject("tts not ready");
            return;
        }
        int from;
        synchronized (lock) {
            if (!paused || queue.isEmpty()) {
                JSObject r = new JSObject();
                r.put("resumed", false);
                call.resolve(r);
                return;
            }
            from = Math.max(0, Math.min(resumeIndex, queue.size() - 1));
            paused = false;
            resumeIndex = -1;
        }
        enqueueFrom(from);
        JSObject r = new JSObject();
        r.put("resumed", true);
        r.put("index", from);
        call.resolve(r);
    }

    @PluginMethod
    public void stopAll(PluginCall call) {
        synchronized (lock) {
            generation++;
            queue = new ArrayList<>();
            paused = false;
            resumeIndex = -1;
            currentIndex = -1;
        }
        if (tts != null) try { tts.stop(); } catch (Exception ignored) {}
        call.resolve();
    }

    // ---------------------------------------------------------- internals
    // index of the item whose chunk most recently started (binder thread)
    private volatile int currentIndex = -1;

    /** Queue items [from, end) into the engine; the first chunk flushes. */
    private void enqueueFrom(int from) {
        List<Item> items;
        int gen;
        float rate;
        synchronized (lock) {
            generation++;
            gen = generation;
            items = queue;
            rate = queueRate;
            currentIndex = from;
        }
        if (tts == null) return;
        tts.setSpeechRate(rate);
        String lang = null;
        boolean first = true;
        for (int i = from; i < items.size(); i++) {
            Item it = items.get(i);
            if (!it.lang.equals(lang)) {
                // the language is captured per speak() request, so switching
                // here between enqueues gives each item its own voice
                tts.setLanguage(Locale.forLanguageTag(it.lang));
                lang = it.lang;
            }
            for (int c = 0; c < it.chunks.size(); c++) {
                String uid = "raq:" + gen + ":" + i + ":" + c;
                tts.speak(it.chunks.get(c),
                    first ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD,
                    (Bundle) null, uid);
                first = false;
            }
        }
    }

    private static final class Ref {
        String id; int gen; int index; int chunk;
        boolean lastChunk; boolean lastItem;
    }

    /** Resolve an utterance id against the live queue; null if stale. */
    private Ref parse(String utteranceId) {
        if (utteranceId == null || !utteranceId.startsWith("raq:")) return null;
        String[] p = utteranceId.split(":");
        if (p.length != 4) return null;
        try {
            Ref r = new Ref();
            r.gen = Integer.parseInt(p[1]);
            r.index = Integer.parseInt(p[2]);
            r.chunk = Integer.parseInt(p[3]);
            synchronized (lock) {
                if (r.gen != generation || paused) return null;
                if (r.index < 0 || r.index >= queue.size()) return null;
                Item it = queue.get(r.index);
                r.id = it.id;
                r.lastChunk = r.chunk == it.chunks.size() - 1;
                r.lastItem = r.index == queue.size() - 1;
                currentIndex = r.index;
            }
            return r;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private void emit(String event, String id, String message) {
        JSObject ev = new JSObject();
        ev.put("id", id);
        if (message != null) ev.put("message", message);
        notifyListeners(event, ev);
    }

    private void finished(int gen) {
        synchronized (lock) {
            if (gen != generation) return;
            queue = new ArrayList<>();
            paused = false;
            resumeIndex = -1;
            currentIndex = -1;
        }
        notifyListeners("ttsFinished", new JSObject());
    }

    /**
     * Split text into pieces no longer than `max`, preferring a sentence
     * boundary (. ! ? ; : sof pasuq, Greek ano teleia) then any whitespace,
     * else a hard cut.
     */
    static List<String> chunk(String text, int max) {
        List<String> out = new ArrayList<>();
        if (max < 16) max = 16;
        String rest = text;
        while (rest.length() > max) {
            int cut = -1;
            for (int i = max - 1; i > max / 4; i--) {
                char ch = rest.charAt(i);
                if (".!?;:׃··".indexOf(ch) >= 0
                    && i + 1 < rest.length()
                    && Character.isWhitespace(rest.charAt(i + 1))) {
                    cut = i + 1;
                    break;
                }
            }
            if (cut < 0) {
                for (int i = max - 1; i > max / 4; i--) {
                    if (Character.isWhitespace(rest.charAt(i))) { cut = i; break; }
                }
            }
            if (cut < 0) cut = max;
            String piece = rest.substring(0, cut).trim();
            if (!piece.isEmpty()) out.add(piece);
            rest = rest.substring(cut).trim();
        }
        if (!rest.isEmpty()) out.add(rest);
        return out;
    }
}
