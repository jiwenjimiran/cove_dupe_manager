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
  const coverSources = !target.imagePath
    ? [...sources].sort((left, right) => Number(Boolean(right.imagePath)) - Number(Boolean(left.imagePath)) || metadataCount(right) - metadataCount(left))
    : [];
  await updateVideo(targetId, buildMergedVideoUpdate(target, sources));
  for (const coverSource of coverSources) {
    if (await copyVideoCoverImage(targetId, coverSource)) break;
  }

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
  // This endpoint returns the original explicit cover when present, otherwise Cove's generated
  // screenshot. Fetch without max= so an explicit source blob is preserved at full resolution.
  const sourceUrl = `/api/videos/${source?.id}/image`;
  const response = await fetch(sourceUrl);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Could not read cover image from video ${source?.id}.`);
  const blob = await response.blob();
  const form = new FormData();
  form.append("file", blob, `video-${source?.id}-cover`);
  const upload = await fetch(`/api/videos/${targetId}/image`, { method: "POST", body: form });
  if (!upload.ok) {
    const message = await upload.text().catch(() => "");
    throw new Error(message || `Could not copy cover image to video ${targetId}.`);
  }
  return true;
}

export function loadFolders(path) {
  return request(`/api/metadata/library-folders${path ? `?path=${encodeURIComponent(path)}` : ""}`);
}

export function loadTranscodeResolutions(videoId) {
  return request(`/api/stream/video/${videoId}/resolutions`);
}

function mediaUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }

  let shareToken = null;
  let sharePassword = null;
  let accessToken = null;
  try {
    shareToken = sessionStorage.getItem("cove_share_token");
    sharePassword = sessionStorage.getItem("cove_share_password");
    accessToken = localStorage.getItem("cove_access_token");
  } catch { /* Storage can be unavailable in restricted browser contexts. */ }

  if (shareToken) {
    query.set("share_token", shareToken);
    if (sharePassword) query.set("share_password", sharePassword);
  } else if (accessToken) {
    query.set("access_token", accessToken);
  }

  const suffix = query.toString();
  return `${path}${suffix ? `?${suffix}` : ""}`;
}

export const mediaUrls = {
  screenshot: (id, version) => mediaUrl(`/api/stream/video/${id}/screenshot`, { v: version }),
  preview: (id) => mediaUrl(`/api/stream/video/${id}/preview`),
  stream: (id) => mediaUrl(`/api/stream/video/${id}`),
  transcode: (id, start = 0, resolution) => mediaUrl(`/api/stream/video/${id}/transcode`, {
    resolution,
    start: Number(start) > 0 ? start : undefined,
  }),
};
