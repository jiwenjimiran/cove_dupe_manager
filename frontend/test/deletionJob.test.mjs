import test from "node:test";
import assert from "node:assert/strict";
import { ApiRequestError, AuthenticationRequiredError } from "../src/api.js";
import { buildDeletionQueue, removeVideoIdsFromGroups, runDeletionJob } from "../src/deletionJob.js";

const video = (id, metadata = 0) => ({ id, title: `Video ${id}`, details: metadata > 0 ? "details" : null, tags: Array.from({ length: metadata }, (_, index) => ({ id: index + 1 })) });

test("deletion queue uses metadata precedence and de-duplicates sources", () => {
  const keeper = video(10);
  const rich = video(1, 3);
  const sparse = video(2, 0);
  const plans = [{ target: keeper, sources: [sparse, rich] }, { target: video(11), sources: [rich] }];
  assert.deepEqual(buildDeletionQueue(plans).map((item) => item.sourceId), [1, 2]);
  assert.deepEqual(buildDeletionQueue(plans, { overwriteConflicts: true }).map((item) => item.sourceId), [2, 1]);
});

test("job copies and deletes each source before starting the next", async () => {
  const calls = [];
  const progress = [];
  const result = await runDeletionJob({
    queue: [{ targetId: 10, sourceId: 1 }, { targetId: 10, sourceId: 2 }],
    options: { copyMetadata: true, overwriteConflictingMetadata: false },
    copyMetadata: async (_targetId, [sourceId]) => { calls.push(`copy:${sourceId}`); return { warnings: [] }; },
    mergeEngagement: async (_targetId, [sourceId]) => { calls.push(`engagement:${sourceId}`); },
    removeVideo: async (sourceId, options) => { calls.push(`delete:${sourceId}:${options.deleteFiles}:${options.deleteGenerated}`); },
    onProgress: (value) => progress.push(`${value.stage}:${value.sourceId}`),
  });
  assert.deepEqual(calls, ["copy:1", "engagement:1", "delete:1:false:false", "copy:2", "engagement:2", "delete:2:false:false"]);
  assert.deepEqual(result.completedIds, [1, 2]);
  assert.deepEqual(progress, ["metadata:1", "deleting:1", "deleted:1", "metadata:2", "deleting:2", "deleted:2"]);
});

test("authentication failure stops with completed and untouched IDs", async () => {
  const result = await runDeletionJob({
    queue: [{ targetId: 10, sourceId: 1 }, { targetId: 10, sourceId: 2 }, { targetId: 10, sourceId: 3 }],
    options: { copyMetadata: true },
    copyMetadata: async (_targetId, [sourceId]) => {
      if (sourceId === 2) throw new AuthenticationRequiredError("refresh failed");
      return { warnings: [] };
    },
    mergeEngagement: async () => {},
    removeVideo: async () => {},
  });
  assert.equal(result.status, "auth_required");
  assert.deepEqual(result.completedIds, [1]);
  assert.deepEqual(result.interrupted, { sourceId: 2, message: "refresh failed" });
  assert.deepEqual(result.notAttemptedIds, [3]);
});

test("authentication failure during deletion does not retry or continue", async () => {
  const deleted = [];
  const result = await runDeletionJob({
    queue: [{ targetId: 10, sourceId: 1 }, { targetId: 10, sourceId: 2 }],
    options: { copyMetadata: false },
    mergeEngagement: async () => {},
    removeVideo: async (sourceId) => {
      deleted.push(sourceId);
      throw new AuthenticationRequiredError("session expired");
    },
  });
  assert.deepEqual(deleted, [1]);
  assert.deepEqual(result.interrupted, { sourceId: 1, message: "session expired" });
  assert.deepEqual(result.notAttemptedIds, [2]);
});

test("ordinary metadata failure keeps that source and continues", async () => {
  const deleted = [];
  const result = await runDeletionJob({
    queue: [{ targetId: 10, sourceId: 1 }, { targetId: 10, sourceId: 2 }],
    options: { copyMetadata: true },
    copyMetadata: async (_targetId, [sourceId]) => {
      if (sourceId === 1) throw new Error("bad metadata");
      return { warnings: [] };
    },
    mergeEngagement: async () => {},
    removeVideo: async (sourceId) => deleted.push(sourceId),
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(deleted, [2]);
  assert.deepEqual(result.failed, [{ sourceId: 1, stage: "metadata", message: "bad metadata" }]);
});

test("ambiguous delete failure reconciles a video that is already gone", async () => {
  const result = await runDeletionJob({
    queue: [{ targetId: 10, sourceId: 1 }],
    options: { copyMetadata: false },
    mergeEngagement: async () => {},
    removeVideo: async () => { throw new TypeError("connection closed"); },
    loadVideo: async () => { throw new ApiRequestError(404, "Not Found"); },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.completedIds, [1]);
});

test("job passes permanent source and generated-file choices directly to Cove", async () => {
  const calls = [];
  await runDeletionJob({
    queue: [{ targetId: 10, sourceId: 1 }],
    options: { copyMetadata: false, deleteFiles: true, deleteGenerated: true },
    mergeEngagement: async () => {},
    removeVideo: async (sourceId, options) => calls.push({ sourceId, options }),
  });
  assert.deepEqual(calls, [{ sourceId: 1, options: { deleteFiles: true, deleteGenerated: true } }]);
});

test("engagement failure keeps the source record and file", async () => {
  const deleted = [];
  const result = await runDeletionJob({
    queue: [{ targetId: 10, sourceId: 1 }],
    options: { copyMetadata: true, deleteFiles: true },
    copyMetadata: async () => ({ warnings: [] }),
    mergeEngagement: async () => { throw new Error("merge failed"); },
    removeVideo: async (sourceId) => deleted.push(sourceId),
  });
  assert.deepEqual(deleted, []);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.failed, [{ sourceId: 1, stage: "engagement", message: "merge failed" }]);
});

test("completed videos are removed without hiding unresolved groups", () => {
  const groups = [[video(1), video(2), video(3)], [video(4), video(5)]];
  assert.deepEqual(removeVideoIdsFromGroups(groups, [1]).map((group) => group.map((item) => item.id)), [[2, 3], [4, 5]]);
  assert.deepEqual(removeVideoIdsFromGroups(groups, [1, 2]).map((group) => group.map((item) => item.id)), [[4, 5]]);
});
