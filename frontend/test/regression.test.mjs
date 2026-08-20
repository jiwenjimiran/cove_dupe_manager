import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("runtime code cannot create or manage dedup trash", async () => {
  const files = [
    new URL("../src/api.js", import.meta.url),
    new URL("../src/deletionJob.js", import.meta.url),
    new URL("../src/index.jsx", import.meta.url),
    new URL("../../src/DuplicateManager/MergeBackend.cs", import.meta.url),
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  for (const forbidden of [".dedup-trash", "/files/prepare", "/files/finalize", "/trash/restore", "/trash/empty"])
    assert.equal(source.includes(forbidden), false, `runtime code still contains ${forbidden}`);
});

test("deletion progress does not expose internal stages or per-item completed counts", async () => {
  const source = await readFile(new URL("../src/index.jsx", import.meta.url), "utf8");
  for (const forbidden of ["Copying metadata", "completed. This might take a while", "progress.stage === \"metadata\""])
    assert.equal(source.includes(forbidden), false, `progress UI still contains ${forbidden}`);
  assert.match(source, /Deleting video .*dm-progress-number.* of .*This might take a while\./s);
});
