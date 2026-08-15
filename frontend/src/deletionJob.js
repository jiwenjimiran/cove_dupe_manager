import { copyVideoMetadata, deleteVideo, finalizeFileAction, getVideo, mergeVideoEngagement, prepareFileAction, ApiRequestError, isAuthenticationRequired } from "./api.js";
import { metadataCount } from "./core.js";

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
  copyMetadata = copyVideoMetadata,
  removeVideo = deleteVideo,
  loadVideo = getVideo,
  mergeEngagement = mergeVideoEngagement,
  prepareFiles = prepareFileAction,
  finalizeFiles = finalizeFileAction,
} = {}) {
  const items = [...(queue || [])];
  const result = {
    status: "complete",
    total: items.length,
    completedIds: [],
    failed: [],
    warnings: [],
    interrupted: null,
    notAttemptedIds: [],
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    let prepared = null;
    if (options.copyMetadata) {
      onProgress(progress("metadata", index, items.length, item, result));
      try {
        const copied = await copyMetadata(item.targetId, [item.sourceId], {
          overwriteConflicts: options.overwriteConflictingMetadata,
        });
        for (const warning of copied?.warnings || []) result.warnings.push({ sourceId: item.sourceId, message: warning });
      } catch (reason) {
        if (isAuthenticationRequired(reason)) return stopForAuthentication(result, items, index, reason);
        result.failed.push({ sourceId: item.sourceId, stage: "metadata", message: reason.message || "Metadata copy failed." });
        continue;
      }
    }

    if (options.preserveEngagement || (options.fileMode && options.fileMode !== "records")) {
      try {
        if (options.preserveEngagement) await mergeEngagement(item.targetId, [item.sourceId]);
        if (options.fileMode && options.fileMode !== "records")
          prepared = await prepareFiles("video", item.sourceId, options.fileMode);
      } catch (reason) {
        result.failed.push({ sourceId: item.sourceId, stage: "preparation", message: reason.message || "Could not prepare safe cleanup." });
        continue;
      }
    }

    onProgress(progress("deleting", index, items.length, item, result));
    try {
      await removeVideo(item.sourceId, { ...options, deleteFiles: false });
      if (prepared?.token) await finalizeFiles(prepared.token);
      result.completedIds.push(item.sourceId);
      onProgress(progress("deleted", index, items.length, item, result));
    } catch (reason) {
      if (isAuthenticationRequired(reason)) return stopForAuthentication(result, items, index, reason);
      const reconciliation = await reconcileDeletion(item.sourceId, loadVideo);
      if (reconciliation === "deleted") {
        result.completedIds.push(item.sourceId);
        onProgress(progress("deleted", index, items.length, item, result));
      } else if (reconciliation?.authError) {
        return stopForAuthentication(result, items, index, reconciliation.authError);
      } else {
        result.failed.push({ sourceId: item.sourceId, stage: "deletion", message: reason.message || "Deletion failed." });
      }
    }
  }

  if (result.failed.length > 0) result.status = "partial";
  return result;
}

export function removeVideoIdsFromGroups(groups, ids) {
  const removed = ids instanceof Set ? ids : new Set(ids || []);
  return (groups || []).map((group) => group.filter((video) => !removed.has(video.id))).filter((group) => group.length > 1);
}

function progress(stage, index, total, item, result) {
  return {
    stage,
    current: index + 1,
    total,
    sourceId: item.sourceId,
    targetId: item.targetId,
    completed: result.completedIds.length,
    failed: result.failed.length,
    warnings: result.warnings.length,
  };
}

async function reconcileDeletion(sourceId, loadVideo) {
  try {
    await loadVideo(sourceId);
    return "present";
  } catch (reason) {
    if (isAuthenticationRequired(reason)) return { authError: reason };
    if (reason instanceof ApiRequestError && reason.status === 404) return "deleted";
    return "unknown";
  }
}

function stopForAuthentication(result, items, index, reason) {
  result.status = "auth_required";
  result.authError = reason.message || "Cove authentication could not be refreshed.";
  result.interrupted = { sourceId: items[index].sourceId, message: result.authError };
  result.notAttemptedIds = items.slice(index + 1).map((item) => item.sourceId);
  return result;
}
