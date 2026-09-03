// Build the portable desktop edition into ../dist/desktop/<name>-<platform>-<arch>/
//   node pack.js            (current platform)   node pack.js linux   node pack.js win32
// Uses the packager API directly (the npm-script form mangled its --ignore
// regex on Windows). www/ and data/ ride along as extra resources, so the
// app folder itself stays small and the databases sit next to it.
"use strict";
const path = require("node:path");
// extract-zip stalls on the Electron archive under this Node (see shims/):
// substitute the shell unzipper before the packager loads its dependency
const ezPath = require.resolve("extract-zip");
require.cache[ezPath] = { id: ezPath, filename: ezPath, loaded: true, exports: require("./shims/extract-zip") };
const { packager } = require("@electron/packager");

const platform = process.argv[2] || process.platform;

packager({
  dir: __dirname,
  name: "Library422",
  executableName: "Library422",
  platform,
  arch: "x64",
  out: path.join(__dirname, "..", "dist", "desktop"),
  overwrite: true,
  asar: false,
  prune: true,
  ignore: [/^\/www($|\/)/, /^\/data($|\/)/, /^\/pack\.js$/, /^\/shims($|\/)/,
           /^\/node_modules\/(\.bin|electron|@electron)(\/|$)/],
  extraResource: [path.join(__dirname, "www"), path.join(__dirname, "data")],
  appCopyright: "Library 422 — public domain and open-licensed sources; see Settings",
  win32metadata: { CompanyName: "Library 422", FileDescription: "Library 422 — offline Bible study", ProductName: "Library 422" },
}).then((paths) => {
  console.log("packaged:", paths.join(", "));
}).catch((e) => {
  console.error("packaging failed:", e.stack || e.message);
  process.exit(1);
});
