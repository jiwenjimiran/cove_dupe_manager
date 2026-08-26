import {
  getImageDeletionJob,
  getVideoDeletionJob,
  startImageDeletionJob,
  startVideoDeletionJob,
} from "./api.js";
import { metadataCount } from "./core.js";

const TERMINAL_STATUSES = new Set(["complete", "partial", "failed", "cancelled"]);

export function buildDeletionQueue(plans, { overwriteConflicts = false } = {}) {
  const queuedIds = new Set();
  const queue = [];
  for (const plan of plans || []) {
    const sources = [...(plan.sources || [])].sort((left, right) => {
      const delta = metadataCount(right) - metadataCount(left);
      return overwriteConflicts ? -delta : delta;
    });
    for (const source of sources) {
      if (!source?.id || queuedIds.has(source.id)) continue;
      queuedIds.add(source.id);
      queue.push({ targetId: plan.target.id, sourceId: source.id });
    }
  }
  return queue;
}

export async function runDeletionJob({
  queue,
  options,
  onProgress = () => {},
  startJob = startVideoDeletionJob,
  loadJob = getVideoDeletionJob,
  wait = delay,
  pollInterval = 750,
} = {}) {
  const started = await startJob([...(queue || [])], options || {});
  return waitForDeletionJob(started, { loadJob, onProgress, wait, pollInterval });
}

export async function runImageDeletionJob({
  targetImageId,
  sourceImageIds,
  fileIds,
  onProgress = () => {},
  startJob = startImageDeletionJob,
  loadJob = getImageDeletionJob,
  wait = delay,
  pollInterval = 750,
} = {}) {
  const started = await startJob(targetImageId, sourceImageIds, fileIds);
  return waitForDeletionJob(started, { loadJob, onProgress, wait, pollInterval });
}

export async function waitForDeletionJob(started, {
  loadJob,
  onProgress = () => {},
  wait = delay,
  pollInterval = 750,
} = {}) {
  if (!started?.operationId) throw new Error("Cove did not return a deletion job id.");
  let snapshot = started;
  while (true) {
    onProgress(deletionJobProgress(snapshot));
    if (TERMINAL_STATUSES.has(snapshot.status)) return deletionJobResult(snapshot);
    await wait(pollInterval);
    snapshot = await loadJob(started.operationId);
  }
}

export function deletionJobProgress(snapshot) {
  const total = Math.max(0, Math.trunc(Number(snapshot?.total) || 0));
  const processed = Math.min(total, Math.max(0, Math.trunc(Number(snapshot?.processed) || 0)));
  return {
    operationId: snapshot?.operationId,
    coreJobId: snapshot?.coreJobId,
    stage: snapshot?.stage || "queued",
    current: total === 0 ? 0 : Math.min(total, processed + (TERMINAL_STATUSES.has(snapshot?.status) ? 0 : 1)),
    total,
    completed: snapshot?.completedIds?.length || 0,
    failed: snapshot?.failed?.length || 0,
    warnings: snapshot?.warnings?.length || 0,
    sourceId: snapshot?.currentSourceId ?? null,
    targetId: snapshot?.currentTargetId ?? null,
  };
}

export function deletionJobResult(snapshot) {
  return {
    ...snapshot,
    status: snapshot?.status || "failed",
    completedIds: [...(snapshot?.completedIds || [])],
    failed: [...(snapshot?.failed || [])],
    warnings: [...(snapshot?.warnings || [])],
  };
}

export function removeVideoIdsFromGroups(groups, ids) {
  const removed = ids instanceof Set ? ids : new Set(ids || []);
  return (groups || []).map((group) => group.filter((video) => !removed.has(video.id))).filter((group) => group.length > 1);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
