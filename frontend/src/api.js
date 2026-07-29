import { buildMergedVideoUpdate, metadataCount, segmentSignature } from "./core.js";

const SETTINGS_URL = "/api/ext/duplicate-manager/settings";

export async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(body?.message || body?.detail || body || response.statusText);
  return body;
}

export function loadSettings() {
  return request(SETTINGS_URL);
}

export function saveSettings(settings) {
  return request(SETTINGS_URL, { method: "PUT", body: JSON.stringify(settings) });
}

export function findDuplicates(options) {
  const params = new URLSearchParams({
    matchType: options.matchType,
    distance: String(options.matchType === "phash" ? options.phashDistance : 0),
  });
  if (options.matchType === "phash") params.set("durationDiff", String(options.maxDurationDelta));
  return request(`/api/videos/duplicates?${params}`);
}

export function deleteVideos(ids, { deleteFiles, deleteGenerated }) {
  return request("/api/videos/destroy", {
    method: "POST",
    body: JSON.stringify({ ids, deleteFiles, deleteGenerated }),
  });
}

export function getVideo(id) {
  return request(`/api/videos/${id}`);
}

export function updateVideo(id, update) {
  return request(`/api/videos/${id}`, { method: "PUT", body: JSON.stringify(update) });
}

export function listSegments(videoId) {
  return request(`/api/videos/${videoId}/segments`);
}

export function createSegment(videoId, segment) {
  const fields = ["startSec", "endSec", "tagId", "kind", "refId", "payload", "sourceKey", "sourceRunId", "confidence", "title", "colorHint"];
  const body = Object.fromEntries(fields.filter((field) => segment?.[field] !== undefined).map((field) => [field, segment[field]]));
  return request(`/api/videos/${videoId}/segments`, { method: "POST", body: JSON.stringify(body) });
}

export function getRatings(videoId) {
  return request(`/api/videos/${videoId}/ratings`);
}

export function setRating(videoId, aspect, value) {
  return request(`/api/videos/${videoId}/rating`, { method: "POST", body: JSON.stringify({ aspect, value }) });
}

export async function copyVideoMetadata(targetId, sourceIds) {
  const [target, ...sources] = await Promise.all([targetId, ...(sourceIds || [])].map(getVideo));
  const segmentLists = await Promise.all([targetId, ...(sourceIds || [])].map(listSegments));
  const ratingLists = await Promise.all([targetId, ...(sourceIds || [])].map(getRatings));
  const coverSource = !target.imagePath
    ? sources.filter((source) => source.imagePath).sort((left, right) => metadataCount(right) - metadataCount(left))[0]
    : null;
  await updateVideo(targetId, buildMergedVideoUpdate(target, sources));
  if (coverSource) await copyVideoCoverImage(targetId, coverSource);

  const mergedRatings = Object.assign({}, ...ratingLists.slice(1).map((item) => item?.ratings || {}).reverse(), ratingLists[0]?.ratings || {});
  for (const [aspect, value] of Object.entries(mergedRatings)) {
    if (ratingLists[0]?.ratings?.[aspect] === undefined) await setRating(targetId, aspect, value);
  }

  const existing = new Set((segmentLists[0] || []).map(segmentSignature));
  for (const segment of segmentLists.slice(1).flat()) {
    const signature = segmentSignature(segment);
    if (existing.has(signature)) continue;
    await createSegment(targetId, segment);
    existing.add(signature);
  }
}

export async function copyVideoCoverImage(targetId, source) {
  // imagePath proves the source has an explicit cover, but contains a display-size limit.
  // Fetch the canonical endpoint without max= so the original blob is preserved.
  const sourceUrl = `/api/videos/${source?.id}/image`;
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Could not read cover image from video ${source?.id}.`);
  const blob = await response.blob();
  const form = new FormData();
  form.append("file", blob, `video-${source?.id}-cover`);
  const upload = await fetch(`/api/videos/${targetId}/image`, { method: "POST", body: form });
  if (!upload.ok) {
    const message = await upload.text().catch(() => "");
    throw new Error(message || `Could not copy cover image to video ${targetId}.`);
  }
}

export function loadFolders(path) {
  return request(`/api/metadata/library-folders${path ? `?path=${encodeURIComponent(path)}` : ""}`);
}

export function loadTranscodeResolutions(videoId) {
  return request(`/api/stream/video/${videoId}/resolutions`);
}

export const mediaUrls = {
  screenshot: (id, version) => `/api/stream/video/${id}/screenshot${version ? `?v=${encodeURIComponent(version)}` : ""}`,
  preview: (id) => `/api/stream/video/${id}/preview`,
  stream: (id) => `/api/stream/video/${id}`,
  transcode: (id, start = 0, resolution) => {
    const params = new URLSearchParams();
    if (resolution) params.set("resolution", resolution);
    if (Number(start) > 0) params.set("start", String(start));
    const query = params.toString();
    return `/api/stream/video/${id}/transcode${query ? `?${query}` : ""}`;
  },
};
