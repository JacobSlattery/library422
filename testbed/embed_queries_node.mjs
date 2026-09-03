// Embed the recall-test questions with the SAME runtime as the corpus
// (transformers.js q8) -> testbed/emb/queries.f32
import { readFileSync, writeFileSync } from "node:fs";
import { pipeline } from "@huggingface/transformers";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tests = JSON.parse(readFileSync(`${ROOT}/testbed/recall_tests.json`, "utf8"));
const extractor = await pipeline(
  "feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
const out = await extractor(tests.map((t) => t.q),
  { pooling: "mean", normalize: true });
writeFileSync(`${ROOT}/testbed/emb/queries.f32`,
  Buffer.from(new Float32Array(out.data).buffer));
console.log(`embedded ${tests.length} queries`);
