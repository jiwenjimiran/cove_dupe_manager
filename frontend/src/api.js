import { buildMergedVideoUpdate, metadataCount, segmentSignature } from "./core.js";

const SETTINGS_URL = "/api/ext/duplicate-manager/settings";
const ACCESS_TOKEN_KEY = "cove_access_token";
const REFRESH_TOKEN_KEY = "cove_refresh_token";
const SHARE_TOKEN_KEY = "cove_share_token";
const SHARE_PASSWORD_KEY = "cove_share_password";
const REFRESH_BEFORE_EXPIRY_MS = 60_000;
let refreshInFlight = null;

export class AuthenticationRequiredError extends Error {
  constructor(message = "Authentication is required.") {
    super(message);
    this.name = "AuthenticationRequiredError";
    this.code = "AUTHENTICATION_REQUIRED";
  }
}

export class ApiRequestError extends Error {
  constructor(status, message, body = null) {
    super(message || `API request failed with status ${status}.`);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

export function isAuthenticationRequired(reason) {
  return reason instanceof AuthenticationRequiredError || reason?.code === "AUTHENTICATION_REQUIRED";
}

export async function request(path, options = {}) {
  const response = await authenticatedFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new ApiRequestError(response.status, body?.message || body?.detail || body || response.statusText, body);
  return body;
}

export async function authenticatedFetch(path, options = {}) {
  await ensureFreshAccessToken();
  const initial = readAuthState();
  let response = await fetchWithAuth(path, options, initial);
  if (response.status !== 401) return response;

  if (initial.shareToken) return failAuthentication("The Cove share session is no longer authorized.");
  const latest = readAuthState();
  if (latest.accessToken && latest.accessToken !== initial.accessToken) {
    response = await fetchWithAuth(path, options, latest);
    if (response.status !== 401) return response;
  }

  if (!latest.refreshToken) return failAuthentication();
  await refreshAccessToken(latest.accessToken, latest.refreshToken);
  response = await fetchWithAuth(path, options, readAuthState());
  if (response.status === 401) return failAuthentication();
  return response;
}

async function ensureFreshAccessToken() {
  const auth = readAuthState();
  if (auth.shareToken || !auth.accessToken || !auth.refreshToken || !tokenExpiresSoon(auth.accessToken)) return;
  await refreshAccessToken(auth.accessToken, auth.refreshToken);
}

async function refreshAccessToken(expectedAccessToken, expectedRefreshToken) {
  const latest = readAuthState();
  if (latest.accessToken && latest.accessToken !== expectedAccessToken && !tokenExpiresSoon(latest.accessToken)) return latest.accessToken;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const before = readAuthState();
    if (before.accessToken && before.accessToken !== expectedAccessToken && !tokenExpiresSoon(before.accessToken)) return before.accessToken;
    const refreshToken = before.refreshToken || expectedRefreshToken;
    if (!refreshToken) throw new AuthenticationRequiredError();
    let response;
    try {
      response = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      throw new AuthenticationRequiredError("Cove authentication could not be refreshed.");
    }
    if (!response.ok) {
      const changed = readAuthState();
      if (changed.accessToken && changed.accessToken !== before.accessToken && !tokenExpiresSoon(changed.accessToken)) return changed.accessToken;
      throw new AuthenticationRequiredError("Cove authentication could not be refreshed.");
    }
    const body = await response.json();
    if (!body?.token) throw new AuthenticationRequiredError("Cove did not return a refreshed access token.");
    writeStoredToken(ACCESS_TOKEN_KEY, body.token);
    writeStoredToken(REFRESH_TOKEN_KEY, body.refreshToken || refreshToken);
    return body.token;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function fetchWithAuth(path, options, auth) {
  const headers = new Headers(options.headers || {});
  if (auth.shareToken) {
    headers.set("X-Share-Token", auth.shareToken);
    if (auth.sharePassword) headers.set("X-Share-Password", auth.sharePassword);
  } else if (auth.accessToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
  }
  return fetch(path, { ...options, credentials: "same-origin", headers });
}

function readAuthState() {
  return {
    accessToken: readStoredToken("localStorage", ACCESS_TOKEN_KEY),
    refreshToken: readStoredToken("localStorage", REFRESH_TOKEN_KEY),
    shareToken: readStoredToken("sessionStorage", SHARE_TOKEN_KEY),
    sharePassword: readStoredToken("sessionStorage", SHARE_PASSWORD_KEY),
  };
}

function readStoredToken(storageName, key) {
  try { return globalThis[storageName]?.getItem(key) || null; } catch { return null; }
}

function writeStoredToken(key, value) {
  try {
    if (value) globalThis.localStorage?.setItem(key, value);
    else globalThis.localStorage?.removeItem(key);
  } catch { /* Storage can be unavailable in restricted browser contexts. */ }
}

function tokenExpiresSoon(token, now = Date.now()) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const decoded = JSON.parse(globalThis.atob(normalized));
    return Number(decoded.exp || 0) * 1000 <= now + REFRESH_BEFORE_EXPIRY_MS;
  } catch { return false; }
}

function failAuthentication(message) {
  try { globalThis.window?.dispatchEvent(new CustomEvent("cove-auth-required")); } catch { /* Non-browser tests do not expose DOM events. */ }
  throw new AuthenticationRequiredError(message);
}

export function loadSettings() {
  return request(SETTINGS_URL);
}

export function saveSettings(settings) {
  return request(SETTINGS_URL, { method: "PUT", body: JSON.stringify(settings) });
}

export function mergeVideoEngagement(targetId, sourceIds) {
  return request("/api/ext/duplicate-manager/videos/engagement-merge", {
    method: "POST", body: JSON.stringify({ targetId, sourceIds }),
  });
}

export function findDuplicateImages({ page = 1, pageSize = 25, minBytes = 0 } = {}) {
  return request(`/api/ext/duplicate-manager/images/duplicates?page=${page}&pageSize=${pageSize}&minBytes=${minBytes}`);
}

export function mergeImages(targetImageId, sourceImageIds) {
  return request("/api/ext/duplicate-manager/images/merge", {
    method: "POST", body: JSON.stringify({ targetImageId, sourceImageIds }),
  });
}

export function pruneImageFiles(imageId, fileIds) {
  return request("/api/ext/duplicate-manager/images/prune", {
    method: "POST", body: JSON.stringify({ imageId, fileIds }),
  });
}

export function deleteImages(ids) {
  return request("/api/images/bulk", {
    method: "DELETE", body: JSON.stringify({ ids, deleteFiles: false, deleteGenerated: true }),
  });
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

export async function deleteVideo(id, options) {
  const result = await deleteVideos([id], options);
  if (Number(result?.deleted || 0) === 1) return true;
  try {
    await getVideo(id);
    throw new Error(`Cove did not delete video ${id}.`);
  } catch (reason) {
    if (reason instanceof ApiRequestError && reason.status === 404) return true;
    throw reason;
  }
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

export async function copyVideoMetadata(targetId, sourceIds, { overwriteConflicts = false } = {}) {
  const ids = [targetId, ...(sourceIds || [])];
  const videos = await Promise.all(ids.map(getVideo));
  const segments = await Promise.all(ids.map(listSegments));
  const ratings = await Promise.all(ids.map(getRatings));
  const target = videos[0];
  const sourceRecords = videos.slice(1).map((video, index) => ({
    video,
    segments: segments[index + 1],
    ratings: ratings[index + 1],
  })).sort((left, right) => metadataCount(right.video) - metadataCount(left.video));
  const sources = sourceRecords.map((record) => record.video);
  const coverSources = (!target.imagePath || overwriteConflicts)
    ? [...sources].sort((left, right) => Number(Boolean(right.imagePath)) - Number(Boolean(left.imagePath)) || metadataCount(right) - metadataCount(left))
    : [];
  const warnings = [];
  await updateVideo(targetId, buildMergedVideoUpdate(target, sources, { overwriteConflicts }));
  let coverCopied = coverSources.length === 0;
  for (const coverSource of coverSources) {
    try {
      if (await copyVideoCoverImage(targetId, coverSource)) {
        coverCopied = true;
        break;
      }
    } catch {
      // Cover transfer is best-effort. Editable metadata, ratings, markers, and deletion can continue.
    }
  }
  if (!coverCopied) warnings.push(`Cover artwork could not be copied to video ${targetId}.`);

  const targetRatings = ratings[0]?.ratings || {};
  const sourceRatings = sourceRecords.map((record) => record.ratings?.ratings || {}).reverse();
  const mergedRatings = overwriteConflicts
    ? Object.assign({}, targetRatings, ...sourceRatings)
    : Object.assign({}, ...sourceRatings, targetRatings);
  for (const [aspect, value] of Object.entries(mergedRatings)) {
    if (overwriteConflicts || targetRatings[aspect] === undefined) await setRating(targetId, aspect, value);
  }

  const existing = new Set((segments[0] || []).map(segmentSignature));
  for (const segment of sourceRecords.flatMap((record) => record.segments || [])) {
    const signature = segmentSignature(segment);
    if (existing.has(signature)) continue;
    await createSegment(targetId, segment);
    existing.add(signature);
  }
  return { warnings };
}

export async function copyVideoCoverImage(targetId, source) {
  // This endpoint returns the original explicit cover when present, otherwise Cove's generated
  // screenshot. Fetch without max= so an explicit source blob is preserved at full resolution.
  const sourceUrl = `/api/videos/${source?.id}/image`;
  const response = await authenticatedFetch(sourceUrl);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Could not read cover image from video ${source?.id}.`);
  const blob = await response.blob();
  const form = new FormData();
  form.append("file", blob, `video-${source?.id}-cover`);
  const upload = await authenticatedFetch(`/api/videos/${targetId}/image`, { method: "POST", body: form });
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
    shareToken = sessionStorage.getItem(SHARE_TOKEN_KEY);
    sharePassword = sessionStorage.getItem(SHARE_PASSWORD_KEY);
    accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
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
