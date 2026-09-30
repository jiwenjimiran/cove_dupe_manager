import test from "node:test";
import assert from "node:assert/strict";
import { findDuplicates, startVideoDeletionJob, getVideoDeletionJob, cancelDuplicateSearch } from "../src/api.js";

const json = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const noWait = async () => {};
async function withFetch(mock, work) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try { await work(); } finally { globalThis.fetch = previous; }
}

test("background search polls then loads every server page, preserving distant matches", async () => {
  let polls = 0, pages = 0;
  const progress = [];
  await withFetch(async (path, options = {}) => {
    if (options.method === "POST") return json({ searchId: "large", jobId: "worker" });
    if (path.includes("/groups?")) {
      pages++;
      assert.equal(new URL(path, "http://test").searchParams.get("page"), String(pages));
      return json({ totalCount: 51, items: Array.from({ length: pages === 1 ? 50 : 1 }, (_, index) => ({ videos: [{ id: pages * 100 + index }, { id: 100001 + index }] })) });
    }
    return json({ status: ++polls === 1 ? "pending" : polls === 2 ? "running" : "completed", candidateCount: 150000 });
  }, async () => {
    const result = await findDuplicates({ matchType: "phash", phashDistance: 8 }, { wait: noWait, onProgress: value => progress.push(value) });
    assert.equal(result.length, 51);
    assert.equal(result[50][1].id, 100001);
  });
  assert.equal(polls, 3); assert.equal(pages, 2);
  assert.ok(progress.some(value => value.candidateCount === 150000));
});

test("failed, cancelled and interrupted searches stop with the server error", async () => {
  for (const status of ["failed", "cancelled", "interrupted"]) {
    await withFetch(async (_path, options = {}) => options.method === "POST"
      ? json({ searchId: status, jobId: "worker" }) : json({ status, error: `server ${status}` }), async () => {
      await assert.rejects(findDuplicates({ matchType: "title" }, { wait: noWait }), new RegExp(`server ${status}`));
    });
  }
});

test("pending search resumes after a transport failure without starting a second job", async () => {
  const previous = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let started = 0, disconnected = true;
  try {
    await withFetch(async (path, options = {}) => {
      if (options.method === "POST") { started++; return json({ searchId: "resume", jobId: "worker" }); }
      if (disconnected) throw new TypeError("Disconnected");
      return json(path.includes("groups?") ? { totalCount: 0, items: [] } : { status: "completed" });
    }, async () => {
      await assert.rejects(findDuplicates({ matchType: "title" }, { wait: noWait }), /Disconnected/);
      assert.equal(values.size, 1);
      disconnected = false;
      await findDuplicates({ matchType: "title" }, { wait: noWait });
      assert.equal(started, 1); assert.equal(values.size, 0);
    });
  } finally { globalThis.sessionStorage = previous; }
});

test("search cancellation targets its core job identifier", async () => {
  await withFetch(async (path, options) => {
    assert.equal(path, "/api/jobs/worker%2F1"); assert.equal(options.method, "DELETE"); return json(null);
  }, () => cancelDuplicateSearch("worker/1"));
});

test("core cleanup batches default merges and reports partial failures", async () => {
  let resolutions = 0;
  await withFetch(async (path, options = {}) => {
    if (path.endsWith("cleanup-searches")) return json({ searchId: "partial", groups: [
      { id: 1, targetId: 10, sourceIds: [11] }, { id: 2, targetId: 20, sourceIds: [21] },
    ] });
    if (path.endsWith("resolve")) {
      resolutions++; assert.deepEqual(JSON.parse(options.body).groupIds, [1, 2]);
      return json({ queuedGroupCount: 2, jobId: "worker" });
    }
    return json({ items: [
      { id: 1, status: "resolved", videos: [{ id: 10 }] },
      { id: 2, status: "failed", error: "Permission changed", videos: [{ id: 20 }, { id: 21 }] },
    ] });
  }, async () => {
    const result = await startVideoDeletionJob([{ targetId: 10, sourceId: 11 }, { targetId: 20, sourceId: 21 }], { copyMetadata: true });
    assert.equal(result.status, "partial"); assert.deepEqual(result.completedIds, [11]);
    assert.equal(result.failed[0].sourceId, 21); assert.equal(result.failed[0].message, "Permission changed");
  });
  assert.equal(resolutions, 1);
});

test("lost cleanup response is reconciled against durable groups", async () => {
  let pending = true;
  await withFetch(async (path) => {
    if (path.endsWith("cleanup-searches")) return json({ searchId: "lost", groups: [{ id: 1, targetId: 10, sourceIds: [11] }] });
    if (path.endsWith("resolve")) throw new TypeError("Lost response");
    return json({ items: [{ id: 1, status: pending ? "queued" : "resolved", videos: pending ? [{ id: 10 }, { id: 11 }] : [{ id: 10 }] }] });
  }, async () => {
    const initial = await startVideoDeletionJob([{ targetId: 10, sourceId: 11 }], {});
    assert.equal(initial.status, "running"); assert.equal(initial.failed.length, 0);
    pending = false;
    const result = await getVideoDeletionJob("lost");
    assert.equal(result.status, "complete"); assert.deepEqual(result.completedIds, [11]);
  });
});

test("conflict overwriting sends explicit cover protection per group", async () => {
  await withFetch(async (path, options = {}) => {
    if (path.endsWith("cleanup-searches")) return json({ searchId: "cover", groups: [{ id: 1, targetId: 10, sourceIds: [11], metadata: { fields: { title: "source", cover: "target" } } }] });
    if (path.endsWith("resolve")) {
      assert.deepEqual(JSON.parse(options.body).metadata.fields, { title: "source", cover: "target" });
      return json({ queuedGroupCount: 1, jobId: "worker" });
    }
    return json({ items: [{ id: 1, status: "resolved", videos: [{ id: 10 }] }] });
  }, async () => {
    assert.equal((await startVideoDeletionJob([{ targetId: 10, sourceId: 11 }], { copyMetadata: true, overwriteConflictingMetadata: true })).status, "complete");
  });
});


test("saved search links reopen core results without creating another job", async () => {
  await withFetch(async (path, options = {}) => {
    assert.notEqual(options.method, "POST");
    assert.ok(path.startsWith("/api/videos/duplicate-searches/saved"));
    return json(path.includes("groups?") ? { totalCount: 1, items: [{ videos: [{ id: 1 }, { id: 2 }] }] }
      : { status: "completed", jobId: "saved-job", matchType: "title", includePaths: ["/library"], excludePaths: [] });
  }, async () => {
    const result = await findDuplicates({ matchType: "fingerprint" }, { resumeSearchId: "saved", wait: noWait });
    assert.deepEqual(result.map(group => group.map(video => video.id)), [[1, 2]]);
  });
});
