import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDeletionQueue,
  deletionJobProgress,
  removeVideoIdsFromGroups,
  runDeletionJob,
  runImageDeletionJob,
  waitForDeletionJob,
} from "../src/deletionJob.js";

const video = (id, metadata = 0) => ({ id, title: `Video ${id}`, details: metadata > 0 ? "details" : null, tags: Array.from({ length: metadata }, (_, index) => ({ id: index + 1 })) });

test("deletion queue uses metadata precedence and de-duplicates sources", () => {
  const keeper = video(10);
  const rich = video(1, 3);
  const sparse = video(2, 0);
  const plans = [{ target: keeper, sources: [sparse, rich] }, { target: video(11), sources: [rich] }];
  assert.deepEqual(buildDeletionQueue(plans).map((item) => item.sourceId), [1, 2]);
  assert.deepEqual(buildDeletionQueue(plans, { overwriteConflicts: true }).map((item) => item.sourceId), [2, 1]);
});

test("video deletion starts one Cove job and polls its server-owned state", async () => {
  const calls = [];
  const progress = [];
  const snapshots = [
    { operationId: "operation-1", coreJobId: "job-1", status: "running", stage: "metadata", total: 2, processed: 0, completedIds: [], failed: [], warnings: [], currentSourceId: 1, currentTargetId: 10 },
    { operationId: "operation-1", coreJobId: "job-1", status: "running", stage: "deletion", total: 2, processed: 1, completedIds: [1], failed: [], warnings: [], currentSourceId: 2, currentTargetId: 10 },
    { operationId: "operation-1", coreJobId: "job-1", status: "complete", stage: "finished", total: 2, processed: 2, completedIds: [1, 2], failed: [], warnings: [] },
  ];
  const result = await runDeletionJob({
    queue: [{ targetId: 10, sourceId: 1 }, { targetId: 10, sourceId: 2 }],
    options: { copyMetadata: true, deleteFiles: true, deleteGenerated: true },
    startJob: async (items, options) => {
      calls.push({ type: "start", items, options });
      return { operationId: "operation-1", coreJobId: "job-1", status: "pending", stage: "queued", total: 2, processed: 0, completedIds: [], failed: [], warnings: [] };
    },
    loadJob: async (operationId) => {
      calls.push({ type: "poll", operationId });
      return snapshots.shift();
    },
    wait: async () => {},
    onProgress: (value) => progress.push(`${value.stage}:${value.current}:${value.completed}`),
  });
  assert.equal(calls.filter((call) => call.type === "start").length, 1);
  assert.equal(calls.filter((call) => call.type === "poll").length, 3);
  assert.deepEqual(result.completedIds, [1, 2]);
  assert.equal(result.coreJobId, "job-1");
  assert.deepEqual(progress, ["queued:1:0", "metadata:1:0", "deletion:2:1", "finished:2:2"]);
});

test("partial server result keeps failure details", async () => {
  const result = await waitForDeletionJob({
    operationId: "operation-2",
    status: "partial",
    stage: "finished",
    total: 2,
    processed: 2,
    completedIds: [1],
    failed: [{ sourceId: 2, stage: "deletion", message: "file locked" }],
    warnings: [{ sourceId: 1, message: "cover unavailable" }],
  }, { loadJob: async () => assert.fail("terminal jobs are not polled") });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.failed, [{ sourceId: 2, stage: "deletion", message: "file locked" }]);
  assert.deepEqual(result.warnings, [{ sourceId: 1, message: "cover unavailable" }]);
});

test("job response must contain an operation id", async () => {
  await assert.rejects(() => waitForDeletionJob({ status: "pending" }, { loadJob: async () => ({}) }), /job id/i);
});

test("image cleanup is also handed to a Cove job", async () => {
  const calls = [];
  const result = await runImageDeletionJob({
    targetImageId: 10,
    sourceImageIds: [11, 12],
    fileIds: [101, 102],
    startJob: async (...args) => {
      calls.push(args);
      return { operationId: "image-operation", status: "complete", stage: "finished", total: 1, processed: 1, completedIds: [10], failed: [], warnings: [] };
    },
    loadJob: async () => assert.fail("terminal jobs are not polled"),
  });
  assert.deepEqual(calls, [[10, [11, 12], [101, 102]]]);
  assert.equal(result.status, "complete");
});

test("server job progress is normalized for the existing UI", () => {
  assert.deepEqual(deletionJobProgress({ total: 845, processed: 31, status: "running", stage: "metadata" }), {
    operationId: undefined,
    coreJobId: undefined,
    stage: "metadata",
    current: 32,
    total: 845,
    completed: 0,
    failed: 0,
    warnings: 0,
    sourceId: null,
    targetId: null,
  });
});

test("completed videos are removed without hiding unresolved groups", () => {
  const groups = [[video(1), video(2), video(3)], [video(4), video(5)]];
  assert.deepEqual(removeVideoIdsFromGroups(groups, [1]).map((group) => group.map((item) => item.id)), [[2, 3], [4, 5]]);
  assert.deepEqual(removeVideoIdsFromGroups(groups, [1, 2]).map((group) => group.map((item) => item.id)), [[4, 5]]);
});
