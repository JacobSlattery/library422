package com.allthingsbible.study;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LlmPlugin.class);
        registerPlugin(TtsPlugin.class);
        super.onCreate(savedInstanceState);
        // Solid, theme-colored system bars...
        getWindow().setStatusBarColor(Color.parseColor("#1a1d27"));
        getWindow().setNavigationBarColor(Color.parseColor("#1a1d27"));
        // ...and MEASURE whatever bars/cutouts this device actually has,
        // then exclude exactly that area from the app's usable region.
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            // The keyboard inset must be applied HERE: this listener consumes
            // all insets, so adjustResize never sees the IME — without this
            // the webview keeps its full height and fixed-bottom UI (the Ask
            // composer) stays hidden behind the keyboard.
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right,
                         Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(content);
    }
}
