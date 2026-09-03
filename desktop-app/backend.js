// SQLite backend for the desktop edition: the same RPC contract as
// app/js/worker.js (init / exec / packs / installPacks / removePack /
// semantic / semanticVerses / warmEmbedder / update), served from the full
// databases on disk with Node's built-in SQLite. The desktop edition ships
// EVERYTHING, so the catalog reports every item installed and downloads
// are a no-op. Semantic search (Ask AI) is not wired yet: the two semantic
// actions return nothing, so Ask falls back to keyword retrieval.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

class Backend {
  constructor(dataDir) {
    this.dir = dataDir;
    this.dbs = {};
    for (const [family, file] of [["bible", "bible.db"], ["works", "works.db"], ["vectors", "vectors.db"]]) {
      const p = path.join(dataDir, file);
      if (fs.existsSync(p)) {
        this.dbs[family] = new DatabaseSync(p, { readOnly: true });
      }
    }
    if (!this.dbs.bible || !this.dbs.works)
      throw new Error(`bible.db / works.db missing in ${dataDir}`);
    const cat = path.join(dataDir, "catalog.json");
    this.catalog = fs.existsSync(cat) ? JSON.parse(fs.readFileSync(cat, "utf8")) : [];
  }

  close() {
    for (const db of Object.values(this.dbs)) { try { db.close(); } catch { /* ignore */ } }
  }

  summary() {
    const counts = this.dbs.bible.prepare(
      `SELECT (SELECT COUNT(*) FROM verses) AS verses,
              (SELECT COUNT(*) FROM words) AS words,
              (SELECT COUNT(*) FROM texts) AS texts`).get();
    counts.library = this.dbs.works.prepare("SELECT COUNT(*) FROM works").get()["COUNT(*)"];
    // everything is on disk: report the whole catalog as installed
    const packs = this.catalog.map((c) => ({
      ...c, installed: c.id !== "vectors" || !!this.dbs.vectors,
      stale: false, available: false,
    }));
    return { counts, updates: {}, packs };
  }

  handle(action, args) {
    switch (action) {
      case "init":
        return { installed: {}, ...this.summary() };
      case "update":
        return this.summary();
      case "exec": {
        const db = this.dbs[args.db ?? "bible"];
        if (!db) throw new Error("database not ready");
        return db.prepare(args.sql).all(...(args.bind ?? []));
      }
      case "packs":
        return this.summary().packs;
      case "installPacks":
      case "removePack":
        throw new Error("The desktop edition includes everything — nothing to download or remove.");
      case "warmEmbedder":
        return true;
      // semantic search runs in the renderer (app/js/semantic-client.js: the
      // vendored embedder + the int8 scan); it pulls the vector blobs from
      // here once per session
      case "vectorsBlob": {
        if (!this.dbs.vectors) throw new Error("AI search data is not installed");
        const row = this.dbs.vectors.prepare(
          "SELECT data FROM vectors WHERE set_name = ? AND name = ?").get(args.set, args.name);
        if (!row) throw new Error(`vectors.db has no "${args.set}" ${args.name}`);
        return row.data;            // Uint8Array -> structured clone over IPC
      }
      case "semantic":
      case "semanticVerses":
        return [];                  // handled renderer-side when vectors exist
      default:
        throw new Error(`unknown action: ${action}`);
    }
  }
}

module.exports = { Backend };
