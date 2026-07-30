// src/index.jsx
import React from "@cove/runtime/react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  Folder,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Trash2,
  X
} from "@cove/runtime/lucide-react";

// src/core.js
var DEFAULT_SETTINGS = Object.freeze({
  matchType: "fingerprint",
  fingerprintAlgorithm: "any",
  phashDistance: 8,
  maxDurationDelta: 10,
  minimumDuration: 0,
  pageSize: 25,
  preferredCodecs: ["av1", "hevc", "h264", "vp9", "mpeg4"],
  keeperRules: ["resolution", "codec", "bitrate", "duration", "metadata", "oldest"],
  folderMode: "all",
  includedPaths: [],
  copyMissingMetadata: true,
  overwriteConflictingMetadata: false
});
var SEARCH_PARAM_NAMES = Object.freeze([
  "match",
  "algorithm",
  "maxDistance",
  "durationDelta",
  "minLength",
  "folderMode",
  "folder",
  "groups",
  "page",
  "query"
]);
var BROWSER_NATIVE_VIDEO_FORMATS = /* @__PURE__ */ new Set(["mp4", "m4v", "webm", "ogg", "ogv", "mpeg", "mpg", "mov"]);
var INCOMPATIBLE_AUDIO_CODECS = /* @__PURE__ */ new Set(["ac3", "eac3", "ec3", "dts", "dtshd", "truehd", "mlp"]);
var RULE_LABELS = Object.freeze({
  metadata: "Most metadata",
  resolution: "Highest resolution",
  duration: "Longest duration",
  codec: "Preferred codec",
  bitrate: "Highest bitrate",
  size: "Largest file",
  oldest: "Oldest file",
  newest: "Newest file"
});
function normalizeSettings(value) {
  const incoming = value || {};
  const incomingPaths = uniqueStrings(incoming.includedPaths, []);
  const migratedDefaults = [
    ["metadata", "resolution", "codec", "bitrate", "size", "oldest"],
    ["resolution", "duration", "codec", "bitrate", "metadata", "oldest"],
    ["resolution", "codec", "duration", "bitrate", "metadata", "oldest"]
  ];
  const keeperRules = Array.isArray(incoming.keeperRules) && migratedDefaults.some((rules) => incoming.keeperRules.join("|") === rules.join("|")) ? DEFAULT_SETTINGS.keeperRules : incoming.keeperRules;
  return {
    ...DEFAULT_SETTINGS,
    ...incoming,
    matchType: ["fingerprint", "phash", "title", "remoteid"].includes(incoming.matchType) ? incoming.matchType : "fingerprint",
    fingerprintAlgorithm: ["any", "md5", "oshash"].includes(incoming.fingerprintAlgorithm) ? incoming.fingerprintAlgorithm : "any",
    phashDistance: clampNumber(incoming.phashDistance, 0, 64, 8),
    maxDurationDelta: clampNumber(incoming.maxDurationDelta, 0, 86400, 10),
    minimumDuration: clampNumber(incoming.minimumDuration, 0, 864e5, 0),
    pageSize: clampNumber(incoming.pageSize, 1, 1e4, 25),
    preferredCodecs: uniqueStrings(incoming.preferredCodecs, DEFAULT_SETTINGS.preferredCodecs),
    keeperRules: uniqueStrings(keeperRules, DEFAULT_SETTINGS.keeperRules).filter((rule) => RULE_LABELS[rule]),
    folderMode: ["include", "exclude"].includes(incoming.folderMode) ? incoming.folderMode : incomingPaths.length > 0 ? "include" : "all",
    includedPaths: incomingPaths,
    copyMissingMetadata: incoming.copyMissingMetadata !== false,
    overwriteConflictingMetadata: incoming.copyMissingMetadata !== false && incoming.overwriteConflictingMetadata === true
  };
}
function duplicateSearchFromUrl(search) {
  const params = new URLSearchParams(search || "");
  const hasSearchParams = SEARCH_PARAM_NAMES.some((name) => params.has(name));
  const patch = {};
  if (params.has("match")) patch.matchType = params.get("match");
  if (params.has("algorithm")) patch.fingerprintAlgorithm = params.get("algorithm");
  if (params.has("maxDistance")) patch.phashDistance = params.get("maxDistance");
  if (params.has("durationDelta")) patch.maxDurationDelta = params.get("durationDelta");
  if (params.has("minLength")) patch.minimumDuration = params.get("minLength");
  if (params.has("folderMode")) patch.folderMode = params.get("folderMode");
  if (params.has("folder")) patch.includedPaths = params.getAll("folder");
  if (params.has("groups")) patch.pageSize = params.get("groups");
  const page = Math.max(1, Math.trunc(Number(params.get("page")) || 1));
  const query = params.get("query") || "";
  return { hasSearchParams, settings: patch, page, query };
}
function duplicateSearchToUrl(search, settings, page = 1, filterQuery = "") {
  const normalized = normalizeSettings(settings);
  const params = new URLSearchParams(search || "");
  for (const name of SEARCH_PARAM_NAMES) params.delete(name);
  params.set("match", normalized.matchType);
  params.set("algorithm", normalized.fingerprintAlgorithm);
  params.set("maxDistance", String(normalized.phashDistance));
  params.set("durationDelta", String(normalized.maxDurationDelta));
  params.set("minLength", String(normalized.minimumDuration));
  params.set("folderMode", normalized.folderMode);
  for (const path of normalized.includedPaths) params.append("folder", path);
  params.set("groups", String(normalized.pageSize));
  params.set("page", String(Math.max(1, Math.trunc(Number(page)) || 1)));
  if (String(filterQuery || "").trim()) params.set("query", String(filterQuery).trim());
  const query = params.toString();
  return query ? `?${query}` : "";
}
function comparisonPlayback(video) {
  const file = primaryFile(video);
  const format = normalizeContainer(file?.format, file?.path || file?.basename);
  const codec = normalizeCodec(file?.videoCodec);
  const audioCodec = normalizeCodec(file?.audioCodec);
  return {
    // Cove retains Direct for an unknown format and lets the media error fallback decide.
    transcode: Boolean(format && !BROWSER_NATIVE_VIDEO_FORMATS.has(format)) || INCOMPATIBLE_AUDIO_CODECS.has(audioCodec),
    format,
    codec
  };
}
function transcodeResolutionCandidates(values) {
  const resolutions = uniqueStrings(values, []);
  if (resolutions.length === 0) return [null];
  const descending = [...resolutions].reverse();
  return [descending[0], null, ...descending.slice(1)];
}
function prepareGroups(apiGroups, options) {
  const settings = normalizeSettings(options);
  const paths = settings.includedPaths.map(normalizePath).filter(Boolean);
  const scoped = (apiGroups || []).map((group) => group.filter((video) => matchesFolderScope(video, paths, settings.folderMode) && Number(primaryFile(video)?.duration || 0) >= settings.minimumDuration)).filter((group) => group.length > 1);
  if (settings.matchType === "phash") return partitionPhashGroups(scoped, settings);
  if (settings.matchType !== "fingerprint") return mergeOverlappingGroups(scoped);
  const candidates = uniqueVideos(scoped.flat());
  const byFingerprint = /* @__PURE__ */ new Map();
  for (const video of candidates) {
    for (const file of video.files || []) {
      for (const fingerprint of file.fingerprints || []) {
        const type = String(fingerprint.type || "").toLowerCase();
        if (!fingerprint.value || !["md5", "oshash"].includes(type)) continue;
        if (settings.fingerprintAlgorithm !== "any" && settings.fingerprintAlgorithm !== type) continue;
        const key = `${type}:${fingerprint.value}`;
        const list = byFingerprint.get(key) || [];
        list.push(video);
        byFingerprint.set(key, list);
      }
    }
  }
  return mergeOverlappingGroups([...byFingerprint.values()].map(uniqueVideos).filter((group) => group.length > 1));
}
function filterGroups(groups, query) {
  const terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return groups || [];
  return (groups || []).filter((group) => group.some((video) => {
    const haystack = searchableText(video);
    return terms.every((term) => haystack.includes(term));
  }));
}
function chooseKeeper(group, settings) {
  const normalized = normalizeSettings(settings);
  return [...group || []].sort((left, right) => compareVideos(left, right, normalized))[0] || null;
}
function autoSelectForDeletion(groups, settings) {
  const selected = /* @__PURE__ */ new Set();
  for (const group of groups || []) {
    const keeper = chooseKeeper(group, settings);
    for (const video of group) if (!keeper || video.id !== keeper.id) selected.add(video.id);
  }
  return selected;
}
function validateKeeperSafety(groups, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  return (groups || []).map((group, index) => ({ index, group, remaining: group.filter((video) => !selected.has(video.id)) })).filter((entry) => entry.group.some((video) => selected.has(video.id)) && entry.remaining.length === 0);
}
function selectedSummary(groups, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const videos = uniqueVideos((groups || []).flat()).filter((video) => selected.has(video.id));
  const files = videos.flatMap((video) => video.files || []);
  return {
    videos: videos.length,
    files: files.length,
    bytes: files.reduce((total, file) => total + Number(file.size || 0), 0)
  };
}
function metadataCount(video) {
  let count = 0;
  for (const key of ["title", "code", "details", "director", "date", "studioId", "studioName", "captions", "imagePath", "rating"]) {
    const value = video?.[key];
    if (value !== null && value !== void 0 && value !== "" && value !== false) count++;
  }
  count += video?.tags?.length || 0;
  count += video?.performers?.length || 0;
  count += video?.urls?.length || 0;
  count += video?.remoteIds?.length || 0;
  count += Object.values(video?.customFields || {}).filter((value) => value !== null && value !== void 0 && value !== "").length;
  return count;
}
function primaryFile(video) {
  return [...video?.files || []].sort((a, b) => fileResolution(b) - fileResolution(a) || Number(b.size || 0) - Number(a.size || 0))[0] || null;
}
function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit++;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
}
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function displayPath(value, maxLength = 144) {
  const path = String(value || "");
  return path.length <= maxLength ? path : `${path.slice(0, Math.max(1, maxLength - 3))}...`;
}
function parseDurationInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  const parts = text.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((part) => part >= 60)) return null;
  return parts.length === 2 ? numbers[0] * 60 + numbers[1] : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}
function formatDurationInput(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remaining = total % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}` : `${minutes}:${String(remaining).padStart(2, "0")}`;
}
function phashComparison(leftVideo, rightVideo, threshold = 0) {
  const left = primaryFile(leftVideo);
  const right = primaryFile(rightVideo);
  const distance = minimumPhashDistance(leftVideo, rightVideo);
  const leftSize = Number(left?.size || 0);
  const rightSize = Number(right?.size || 0);
  const leftResolution = `${Number(left?.width || 0)}x${Number(left?.height || 0)}`;
  const rightResolution = `${Number(right?.width || 0)}x${Number(right?.height || 0)}`;
  const leftCodec = normalizeCodec(left?.videoCodec);
  const rightCodec = normalizeCodec(right?.videoCodec);
  const leftDuration = Number(left?.duration || 0);
  const rightDuration = Number(right?.duration || 0);
  const sizeDifference = rightSize - leftSize;
  const durationDifference = Number((rightDuration - leftDuration).toFixed(1));
  return {
    phash: { matches: distance !== null && distance <= Number(threshold || 0), value: distance === null ? "unavailable" : String(distance) },
    size: { matches: leftSize === rightSize, value: leftSize === rightSize ? "matches" : `${formatBytesOneDecimal(Math.abs(sizeDifference))} ${sizeDifference > 0 ? "larger" : "smaller"}` },
    resolution: { matches: leftResolution === rightResolution, value: leftResolution === rightResolution ? "matches" : `${leftResolution} vs ${rightResolution}` },
    codec: { matches: leftCodec === rightCodec, value: leftCodec === rightCodec ? "matches" : `codec ${left?.videoCodec || "unknown"} vs codec ${right?.videoCodec || "unknown"}` },
    duration: { matches: durationDifference === 0, value: durationDifference === 0 ? "matches" : `${formatSeconds(Math.abs(durationDifference))} ${durationDifference > 0 ? "longer" : "shorter"}` }
  };
}
function metadataCopyCount(target, source) {
  let count = 0;
  for (const field of ["title", "code", "details", "director", "date", "studioId", "captions"]) {
    if (!isPopulated(target?.[field]) && isPopulated(source?.[field])) count++;
  }
  count += missingPrimitiveCount(target?.urls, source?.urls);
  count += missingRelationCount(target?.tags, source?.tags);
  count += missingRelationCount(target?.performers, source?.performers);
  count += missingRelationCount(target?.galleries, source?.galleries);
  count += missingRelationCount(target?.groups, source?.groups);
  count += missingObjectCount(target?.remoteIds, source?.remoteIds);
  const targetFields = target?.customFields || {};
  count += Object.entries(source?.customFields || {}).filter(([key, value]) => !isPopulated(targetFields[key]) && isPopulated(value)).length;
  if (!isPopulated(target?.imagePath) && isPopulated(source?.imagePath)) count++;
  return count;
}
function buildMergedVideoUpdate(target, sources, { overwriteConflicts = false } = {}) {
  const ordered = [...sources || []].sort((a, b) => metadataCount(b) - metadataCount(a));
  const scalarFields = ["title", "code", "details", "director", "date", "rating", "studioId", "captions", "organized", "isVr"];
  const update = {};
  for (const field of scalarFields) {
    const sourceValues = ordered.map((item) => item?.[field]);
    update[field] = overwriteConflicts ? firstPopulated(...sourceValues, target?.[field]) : firstPopulated(target?.[field], ...sourceValues);
  }
  update.urls = uniquePrimitive([...target?.urls || [], ...ordered.flatMap((item) => item?.urls || [])]);
  update.tagIds = uniqueIds([...target?.tags || [], ...ordered.flatMap((item) => item?.tags || [])]);
  update.performerIds = uniqueIds([...target?.performers || [], ...ordered.flatMap((item) => item?.performers || [])]);
  update.galleryIds = uniqueIds([...target?.galleries || [], ...ordered.flatMap((item) => item?.galleries || [])]);
  const sourceGroups = ordered.flatMap((item) => item?.groups || []);
  update.groups = uniqueGroups(overwriteConflicts ? [...sourceGroups, ...target?.groups || []] : [...target?.groups || [], ...sourceGroups]);
  update.remoteIds = mergeKeyed(target?.remoteIds, ordered.map((item) => item?.remoteIds), overwriteConflicts);
  update.customFields = mergeKeyed(target?.customFields, ordered.map((item) => item?.customFields), overwriteConflicts);
  return update;
}
function segmentSignature(segment) {
  return [segment?.startSec, segment?.endSec, segment?.tagId, segment?.kind, segment?.refId, segment?.title].map((value) => String(value ?? "")).join("|");
}
function compareVideos(left, right, settings) {
  for (const rule of settings.keeperRules) {
    const delta = ruleValue(right, rule, settings) - ruleValue(left, rule, settings);
    if (delta !== 0 && Number.isFinite(delta)) return delta;
  }
  return Number(left.id || 0) - Number(right.id || 0);
}
function ruleValue(video, rule, settings) {
  const file = primaryFile(video);
  if (rule === "metadata") return metadataCount(video);
  if (rule === "resolution") return fileResolution(file);
  if (rule === "duration") return Number(file?.duration || 0);
  if (rule === "codec") {
    const codec = normalizeCodec(file?.videoCodec);
    const index = settings.preferredCodecs.map(normalizeCodec).indexOf(codec);
    return index < 0 ? -1e3 : settings.preferredCodecs.length - index;
  }
  if (rule === "bitrate") return Number(file?.bitRate || 0);
  if (rule === "size") return Number(file?.size || 0);
  const time = Date.parse(file?.modTime || 0) || 0;
  if (rule === "oldest") return -time;
  if (rule === "newest") return time;
  return 0;
}
function fileResolution(file) {
  return Number(file?.width || 0) * Number(file?.height || 0);
}
function normalizeCodec(value) {
  const codec = String(value || "").trim().toLowerCase().replace(/[._-]/g, "");
  if (["h265", "hevc"].includes(codec)) return "hevc";
  if (["h264", "avc", "avc1"].includes(codec)) return "h264";
  if (["vp8", "vp80"].includes(codec)) return "vp8";
  if (["vp9", "vp90"].includes(codec)) return "vp9";
  if (["av1", "av01"].includes(codec)) return "av1";
  if (["mpeg1", "mpeg1video"].includes(codec)) return "mpeg1";
  if (["mpeg2", "mpeg2video"].includes(codec)) return "mpeg2";
  return codec;
}
function normalizeContainer(value, path) {
  const explicit = String(value || "").trim().toLowerCase().replace(/^\./, "");
  if (explicit) return explicit;
  const match = String(path || "").match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}
function minimumPhashDistance(leftVideo, rightVideo) {
  const left = phashes(leftVideo);
  const right = phashes(rightVideo);
  let minimum = null;
  for (const leftHash of left) {
    for (const rightHash of right) {
      try {
        let value = BigInt(`0x${leftHash}`) ^ BigInt(`0x${rightHash}`);
        let count = 0;
        while (value > 0n) {
          count += Number(value & 1n);
          value >>= 1n;
        }
        if (minimum === null || count < minimum) minimum = count;
      } catch {
      }
    }
  }
  return minimum;
}
function partitionPhashGroups(groups, settings) {
  const output = [];
  for (const source of groups || []) {
    const videos = uniqueVideos(source).sort((a, b) => Number(a.id) - Number(b.id));
    const candidates = videos.map((seed, seedIndex) => {
      const cluster = [seed];
      for (const video of videos.slice(seedIndex + 1)) {
        if (cluster.every((other) => {
          const distance = minimumPhashDistance(video, other);
          const durationDelta = Math.abs(Number(primaryFile(video)?.duration || 0) - Number(primaryFile(other)?.duration || 0));
          return distance !== null && distance <= settings.phashDistance && durationDelta <= settings.maxDurationDelta;
        })) cluster.push(video);
      }
      return cluster;
    }).filter((cluster) => cluster.length > 1);
    output.push(...candidates.filter((cluster, index) => !candidates.some((other, otherIndex) => otherIndex !== index && cluster.length < other.length && cluster.every((video) => other.some((item) => item.id === video.id)))));
  }
  return output.sort((a, b) => Number(a[0]?.id) - Number(b[0]?.id));
}
function formatBytesOneDecimal(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes.toFixed(1)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit++;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(1)} ${units[unit]}`;
}
function formatSeconds(value) {
  const seconds = Number(value || 0);
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} ${seconds === 1 ? "second" : "seconds"}`;
}
function firstPopulated(...values) {
  return values.find(isPopulated) ?? null;
}
function isPopulated(value) {
  return value !== null && value !== void 0 && (typeof value !== "string" || value.trim() !== "");
}
function missingPrimitiveCount(target, source) {
  const existing = new Set((target || []).map((value) => JSON.stringify(value)));
  return new Set((source || []).map((value) => JSON.stringify(value)).filter((value) => !existing.has(value))).size;
}
function missingRelationCount(target, source) {
  const existing = new Set((target || []).map((value) => String(value?.id ?? value?.groupId ?? value)));
  return new Set((source || []).map((value) => String(value?.id ?? value?.groupId ?? value)).filter((value) => !existing.has(value))).size;
}
function missingObjectCount(target, source) {
  const existing = new Set((target || []).map((value) => JSON.stringify(value)));
  return new Set((source || []).map((value) => JSON.stringify(value)).filter((value) => !existing.has(value))).size;
}
function uniquePrimitive(values) {
  return [...new Set(values.filter((value) => value !== null && value !== void 0 && value !== ""))];
}
function uniqueIds(values) {
  return [...new Set(values.map((value) => value?.id ?? value).filter((value) => value !== null && value !== void 0))];
}
function uniqueObjects(values) {
  const keyed = /* @__PURE__ */ new Map();
  for (const value of values) keyed.set(JSON.stringify(value), value);
  return [...keyed.values()];
}
function uniqueGroups(values) {
  const groups = /* @__PURE__ */ new Map();
  for (const value of values) {
    const groupId = Number(value?.groupId ?? value?.id ?? 0);
    if (groupId > 0 && !groups.has(groupId)) groups.set(groupId, { groupId, videoIndex: Number(value?.videoIndex || 0) });
  }
  return [...groups.values()];
}
function mergeKeyed(primary, fallbacks, overwriteConflicts = false) {
  if (Array.isArray(primary) || (fallbacks || []).some(Array.isArray)) return uniqueObjects([...primary || [], ...(fallbacks || []).flatMap((value) => value || [])]);
  return overwriteConflicts ? Object.assign({}, primary || {}, ...(fallbacks || []).slice().reverse().filter(Boolean)) : Object.assign({}, ...(fallbacks || []).slice().reverse().filter(Boolean), primary || {});
}
function phashes(video) {
  return (video?.files || []).flatMap((file) => file.fingerprints || []).filter((fingerprint) => String(fingerprint.type || "").toLowerCase() === "phash").map((fingerprint) => String(fingerprint.value || "").trim().replace(/^0x/i, "")).filter((value) => /^[0-9a-f]+$/i.test(value));
}
function searchableText(video) {
  return [
    video?.title,
    video?.code,
    video?.details,
    video?.director,
    video?.studioName,
    ...(video?.tags || []).flatMap((item) => [item?.name, item]),
    ...(video?.performers || []).flatMap((item) => [item?.name, item]),
    ...(video?.files || []).flatMap((file) => [file.path, file.basename, file.videoCodec, file.audioCodec, file.format])
  ].filter(Boolean).join(" ").toLowerCase();
}
function mergeOverlappingGroups(groups) {
  const remaining = (groups || []).map(uniqueVideos).filter((group) => group.length > 1);
  const merged = [];
  while (remaining.length > 0) {
    let current = remaining.shift();
    let changed = true;
    while (changed) {
      changed = false;
      const ids = new Set(current.map((video) => video.id));
      for (let index = remaining.length - 1; index >= 0; index--) {
        if (remaining[index].some((video) => ids.has(video.id))) {
          current = uniqueVideos(current.concat(remaining.splice(index, 1)[0]));
          changed = true;
        }
      }
    }
    merged.push(current.sort((a, b) => Number(a.id) - Number(b.id)));
  }
  return merged.sort((a, b) => Number(a[0]?.id) - Number(b[0]?.id));
}
function uniqueVideos(videos) {
  return [...new Map((videos || []).map((video) => [video.id, video])).values()];
}
function uniqueStrings(values, fallback) {
  const source = Array.isArray(values) ? values : fallback;
  return [...new Set((source || []).map((value) => String(value).trim()).filter(Boolean))];
}
function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function isUnderPath(value, roots) {
  const path = normalizePath(value);
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}
function matchesFolderScope(video, paths, mode) {
  if (mode === "all" || paths.length === 0) return true;
  const inside = (video?.files || []).some((file) => isUnderPath(file.path, paths));
  return mode === "exclude" ? !inside : inside;
}
function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

// src/api.js
var SETTINGS_URL = "/api/ext/duplicate-manager/settings";
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers || {} }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(body?.message || body?.detail || body || response.statusText);
  return body;
}
function loadSettings() {
  return request(SETTINGS_URL);
}
function saveSettings(settings) {
  return request(SETTINGS_URL, { method: "PUT", body: JSON.stringify(settings) });
}
function findDuplicates(options) {
  const params = new URLSearchParams({
    matchType: options.matchType,
    distance: String(options.matchType === "phash" ? options.phashDistance : 0)
  });
  if (options.matchType === "phash") params.set("durationDiff", String(options.maxDurationDelta));
  return request(`/api/videos/duplicates?${params}`);
}
function deleteVideos(ids, { deleteFiles, deleteGenerated }) {
  return request("/api/videos/destroy", {
    method: "POST",
    body: JSON.stringify({ ids, deleteFiles, deleteGenerated })
  });
}
function getVideo(id) {
  return request(`/api/videos/${id}`);
}
function updateVideo(id, update) {
  return request(`/api/videos/${id}`, { method: "PUT", body: JSON.stringify(update) });
}
function listSegments(videoId) {
  return request(`/api/videos/${videoId}/segments`);
}
function createSegment(videoId, segment) {
  const fields = ["startSec", "endSec", "tagId", "kind", "refId", "payload", "sourceKey", "sourceRunId", "confidence", "title", "colorHint"];
  const body = Object.fromEntries(fields.filter((field) => segment?.[field] !== void 0).map((field) => [field, segment[field]]));
  return request(`/api/videos/${videoId}/segments`, { method: "POST", body: JSON.stringify(body) });
}
function getRatings(videoId) {
  return request(`/api/videos/${videoId}/ratings`);
}
function setRating(videoId, aspect, value) {
  return request(`/api/videos/${videoId}/rating`, { method: "POST", body: JSON.stringify({ aspect, value }) });
}
async function copyVideoMetadata(targetId, sourceIds, { overwriteConflicts = false } = {}) {
  const ids = [targetId, ...sourceIds || []];
  const videos = await Promise.all(ids.map(getVideo));
  const segments = await Promise.all(ids.map(listSegments));
  const ratings = await Promise.all(ids.map(getRatings));
  const target = videos[0];
  const sourceRecords = videos.slice(1).map((video, index) => ({
    video,
    segments: segments[index + 1],
    ratings: ratings[index + 1]
  })).sort((left, right) => metadataCount(right.video) - metadataCount(left.video));
  const sources = sourceRecords.map((record) => record.video);
  const coverSources = !target.imagePath || overwriteConflicts ? [...sources].sort((left, right) => Number(Boolean(right.imagePath)) - Number(Boolean(left.imagePath)) || metadataCount(right) - metadataCount(left)) : [];
  await updateVideo(targetId, buildMergedVideoUpdate(target, sources, { overwriteConflicts }));
  for (const coverSource of coverSources) {
    if (await copyVideoCoverImage(targetId, coverSource)) break;
  }
  const targetRatings = ratings[0]?.ratings || {};
  const sourceRatings = sourceRecords.map((record) => record.ratings?.ratings || {}).reverse();
  const mergedRatings = overwriteConflicts ? Object.assign({}, targetRatings, ...sourceRatings) : Object.assign({}, ...sourceRatings, targetRatings);
  for (const [aspect, value] of Object.entries(mergedRatings)) {
    if (overwriteConflicts || targetRatings[aspect] === void 0) await setRating(targetId, aspect, value);
  }
  const existing = new Set((segments[0] || []).map(segmentSignature));
  for (const segment of sourceRecords.flatMap((record) => record.segments || [])) {
    const signature = segmentSignature(segment);
    if (existing.has(signature)) continue;
    await createSegment(targetId, segment);
    existing.add(signature);
  }
}
async function copyVideoCoverImage(targetId, source) {
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
function loadFolders(path) {
  return request(`/api/metadata/library-folders${path ? `?path=${encodeURIComponent(path)}` : ""}`);
}
function loadTranscodeResolutions(videoId) {
  return request(`/api/stream/video/${videoId}/resolutions`);
}
function mediaUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0 && value !== null && value !== "") query.set(key, String(value));
  }
  let shareToken = null;
  let sharePassword = null;
  let accessToken = null;
  try {
    shareToken = sessionStorage.getItem("cove_share_token");
    sharePassword = sessionStorage.getItem("cove_share_password");
    accessToken = localStorage.getItem("cove_access_token");
  } catch {
  }
  if (shareToken) {
    query.set("share_token", shareToken);
    if (sharePassword) query.set("share_password", sharePassword);
  } else if (accessToken) {
    query.set("access_token", accessToken);
  }
  const suffix = query.toString();
  return `${path}${suffix ? `?${suffix}` : ""}`;
}
var mediaUrls = {
  screenshot: (id, version) => mediaUrl(`/api/stream/video/${id}/screenshot`, { v: version }),
  preview: (id) => mediaUrl(`/api/stream/video/${id}/preview`),
  stream: (id) => mediaUrl(`/api/stream/video/${id}`),
  transcode: (id, start = 0, resolution) => mediaUrl(`/api/stream/video/${id}/transcode`, {
    resolution,
    start: Number(start) > 0 ? start : void 0
  })
};

// src/session.js
var state = {
  rawGroups: null,
  searchSettings: null,
  query: "",
  page: 1,
  selectedIds: /* @__PURE__ */ new Set(),
  deletion: null,
  dismissedGroupKeys: /* @__PURE__ */ new Set(),
  stale: false
};
function getSession() {
  return state;
}
function clearSession() {
  state.rawGroups = null;
  state.searchSettings = null;
  state.query = "";
  state.page = 1;
  state.selectedIds = /* @__PURE__ */ new Set();
  state.deletion = null;
  state.dismissedGroupKeys = /* @__PURE__ */ new Set();
  state.stale = false;
}

// src/index.jsx
var { useEffect, useMemo, useRef, useState } = React;
function DuplicateManagerPage({ onNavigate }) {
  const session = getSession();
  const initialUrlSearch = useRef(duplicateSearchFromUrl(typeof window === "undefined" ? "" : window.location.search)).current;
  const initialSettings = useRef(normalizeSettings({ ...session.searchSettings || DEFAULT_SETTINGS, ...initialUrlSearch.settings })).current;
  const autoSearchStarted = useRef(false);
  const [settings, setSettings] = useState(initialSettings);
  const [appliedSettings, setAppliedSettings] = useState(session.searchSettings ? normalizeSettings(session.searchSettings) : null);
  const [rawGroups, setRawGroups] = useState(session.rawGroups);
  const [query, setQuery] = useState(initialUrlSearch.hasSearchParams ? initialUrlSearch.query : session.query);
  const [page, setPage] = useState(initialUrlSearch.hasSearchParams ? initialUrlSearch.page : session.page);
  const [selectedIds, setSelectedIds] = useState(new Set(session.selectedIds));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [compareGroup, setCompareGroup] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState(session.deletion?.status || "idle");
  const [folderOpen, setFolderOpen] = useState(false);
  const [dismissedGroupKeys, setDismissedGroupKeys] = useState(new Set(session.dismissedGroupKeys || []));
  const [settingsReady, setSettingsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadSettings().then((value) => {
      if (cancelled) return;
      const next = normalizeSettings({ ...session.searchSettings || value, ...initialUrlSearch.settings });
      setSettings(next);
      setSettingsReady(true);
      if (initialUrlSearch.hasSearchParams && !autoSearchStarted.current) {
        autoSearchStarted.current = true;
        runSearch(next, initialUrlSearch.page);
      }
    }).catch((reason) => {
      if (cancelled) return;
      setError(reason.message);
      setSettingsReady(true);
      if (initialUrlSearch.hasSearchParams && !autoSearchStarted.current) {
        autoSearchStarted.current = true;
        runSearch(initialSettings, initialUrlSearch.page);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!settingsReady || typeof window === "undefined") return;
    const search = duplicateSearchToUrl(window.location.search, settings, page, query);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, [settings, page, query, settingsReady]);
  useEffect(() => {
    const operation = session.deletion;
    if (!operation?.promise || operation.status !== "pending") return;
    let active = true;
    operation.promise.then(() => {
      if (active) setDeleteStatus("complete");
    }).catch((reason) => {
      if (!active) return;
      setRawGroups(session.rawGroups);
      setDeleteStatus("failed");
      setError(`${reason.message || "Deletion failed."} Results were restored; run the search again to reconcile any partial deletion.`);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    session.query = query;
    session.page = page;
    session.selectedIds = new Set(selectedIds);
  }, [query, page, selectedIds]);
  const preparedGroups = useMemo(() => rawGroups ? prepareGroups(rawGroups, appliedSettings || settings) : [], [rawGroups, appliedSettings]);
  const groups = useMemo(() => preparedGroups.filter((group) => !dismissedGroupKeys.has(groupKey(group))), [preparedGroups, dismissedGroupKeys]);
  const filteredGroups = useMemo(() => filterGroups(groups, query), [groups, query]);
  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / settings.pageSize));
  const visibleGroups = filteredGroups.slice((Math.min(page, totalPages) - 1) * settings.pageSize, Math.min(page, totalPages) * settings.pageSize);
  const summary = useMemo(() => selectedSummary(groups, selectedIds), [groups, selectedIds]);
  const unsafeGroups = useMemo(() => validateKeeperSafety(groups, selectedIds), [groups, selectedIds]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  async function runSearch(options = settings, resultPage = 1) {
    const searchSettings = normalizeSettings(options);
    setLoading(true);
    setError("");
    try {
      const result = await findDuplicates(searchSettings);
      setRawGroups(result);
      setSelectedIds(/* @__PURE__ */ new Set());
      setDismissedGroupKeys(/* @__PURE__ */ new Set());
      setPage(Math.max(1, Math.trunc(Number(resultPage)) || 1));
      session.rawGroups = result;
      const snapshot = { ...searchSettings, includedPaths: [...searchSettings.includedPaths] };
      setAppliedSettings(snapshot);
      session.searchSettings = snapshot;
      session.selectedIds = /* @__PURE__ */ new Set();
      session.dismissedGroupKeys = /* @__PURE__ */ new Set();
      session.stale = false;
    } catch (reason) {
      setError(reason.message || "Duplicate search failed.");
    } finally {
      setLoading(false);
    }
  }
  function updateSettings(patch) {
    setSettings((current) => normalizeSettings({ ...current, ...patch }));
  }
  function toggleSelected(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectRecommended(targetGroups = filteredGroups) {
    const targetIds = new Set(targetGroups.flat().map((video) => video.id));
    const recommended = autoSelectForDeletion(targetGroups, settings);
    setSelectedIds((current) => new Set([...current].filter((id) => !targetIds.has(id)).concat([...recommended])));
  }
  function clearSelected(targetGroups = filteredGroups) {
    const targetIds = new Set(targetGroups.flat().map((video) => video.id));
    setSelectedIds((current) => new Set([...current].filter((id) => !targetIds.has(id))));
  }
  function dismissGroup(group) {
    const next = new Set(dismissedGroupKeys).add(groupKey(group));
    const remainingIds = new Set(preparedGroups.filter((candidate) => !next.has(groupKey(candidate))).flat().map((video) => video.id));
    setDismissedGroupKeys(next);
    setSelectedIds((current) => new Set([...current].filter((id) => remainingIds.has(id))));
    session.dismissedGroupKeys = next;
  }
  async function confirmDelete(options) {
    const ids = [...selectedIds];
    if (ids.length === 0 || unsafeGroups.length > 0) return;
    setConfirmOpen(false);
    setDeleteStatus("pending");
    setError("");
    const previous = rawGroups;
    const idSet = new Set(ids);
    if (options.copyMetadata) {
      const plans = groups.filter((group) => group.some((video) => idSet.has(video.id))).map((group) => ({
        target: chooseKeeper(group.filter((video) => !idSet.has(video.id)), appliedSettings || settings),
        sources: group.filter((video) => idSet.has(video.id)).map((video) => video.id)
      }));
      try {
        for (const plan of plans) await copyVideoMetadata(plan.target.id, plan.sources, { overwriteConflicts: options.overwriteConflictingMetadata });
      } catch (reason) {
        setDeleteStatus("failed");
        setError(`${reason.message || "Metadata copy failed."} No videos were deleted.`);
        return;
      }
    }
    const optimistic = (rawGroups || []).map((group) => group.filter((video) => !idSet.has(video.id))).filter((group) => group.length > 1);
    setRawGroups(optimistic);
    setSelectedIds(/* @__PURE__ */ new Set());
    session.rawGroups = optimistic;
    session.selectedIds = /* @__PURE__ */ new Set();
    const operation = { status: "pending", ids, promise: null };
    operation.promise = deleteVideos(ids, options).then(() => {
      operation.status = "complete";
      session.deletion = operation;
      return "complete";
    }).catch((reason) => {
      operation.status = "failed";
      operation.error = reason.message || "Deletion failed.";
      session.rawGroups = previous;
      session.stale = true;
      session.deletion = operation;
      throw reason;
    });
    session.deletion = operation;
    try {
      await operation.promise;
      setDeleteStatus("complete");
    } catch (reason) {
      setRawGroups(previous);
      setDeleteStatus("failed");
      setError(`${reason.message || "Deletion failed."} Results were restored; run the search again to reconcile any partial deletion.`);
    }
  }
  function resetSession() {
    clearSession();
    setRawGroups(null);
    setAppliedSettings(null);
    setSelectedIds(/* @__PURE__ */ new Set());
    setQuery("");
    setPage(1);
    setDeleteStatus("idle");
    setDismissedGroupKeys(/* @__PURE__ */ new Set());
  }
  return /* @__PURE__ */ React.createElement("div", { className: "dm-page" }, /* @__PURE__ */ React.createElement("header", { className: "dm-header" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "dm-title" }, /* @__PURE__ */ React.createElement(Copy, { size: 23 }), /* @__PURE__ */ React.createElement("h1", null, "Duplicate Manager")), /* @__PURE__ */ React.createElement("p", null, "Compare, select, and remove duplicate videos in one operation.")), rawGroups && /* @__PURE__ */ React.createElement("button", { className: "dm-icon-button", title: "Clear cached results", onClick: resetSession }, /* @__PURE__ */ React.createElement(RotateCcw, { size: 18 }))), /* @__PURE__ */ React.createElement("section", { className: "dm-controls" }, /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, "Match type"), /* @__PURE__ */ React.createElement("select", { value: settings.matchType, onChange: (event) => updateSettings({ matchType: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "fingerprint" }, "Exact fingerprint"), /* @__PURE__ */ React.createElement("option", { value: "phash" }, "Visual pHash"), /* @__PURE__ */ React.createElement("option", { value: "title" }, "Same title"), /* @__PURE__ */ React.createElement("option", { value: "remoteid" }, "Same remote ID"))), settings.matchType === "fingerprint" && /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, "Algorithm"), /* @__PURE__ */ React.createElement("select", { value: settings.fingerprintAlgorithm, onChange: (event) => updateSettings({ fingerprintAlgorithm: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "any" }, "MD5 or OSHash"), /* @__PURE__ */ React.createElement("option", { value: "md5" }, "MD5 only"), /* @__PURE__ */ React.createElement("option", { value: "oshash" }, "OSHash only"))), settings.matchType === "phash" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, "Maximum pHash distance"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "0", max: "64", value: settings.phashDistance, onChange: (event) => updateSettings({ phashDistance: Number(event.target.value) }) })), /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, "Duration delta (sec)"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "0", value: settings.maxDurationDelta, onChange: (event) => updateSettings({ maxDurationDelta: Number(event.target.value) }) }))), /* @__PURE__ */ React.createElement(DurationInput, { label: "Minimum length", value: settings.minimumDuration, onChange: (minimumDuration) => updateSettings({ minimumDuration }) }), /* @__PURE__ */ React.createElement(FolderScopeControl, { settings, onChange: updateSettings, onPick: () => setFolderOpen(true) }), /* @__PURE__ */ React.createElement("button", { className: "dm-primary", disabled: loading, onClick: () => runSearch() }, loading ? /* @__PURE__ */ React.createElement(Loader2, { className: "dm-spin", size: 17 }) : /* @__PURE__ */ React.createElement(Search, { size: 17 }), loading ? "Searching" : "Find duplicates")), error && /* @__PURE__ */ React.createElement("div", { className: "dm-alert dm-error" }, /* @__PURE__ */ React.createElement(AlertTriangle, { size: 17 }), /* @__PURE__ */ React.createElement("span", null, error), /* @__PURE__ */ React.createElement("button", { onClick: () => setError("") }, /* @__PURE__ */ React.createElement(X, { size: 15 }))), deleteStatus === "pending" && /* @__PURE__ */ React.createElement("div", { className: "dm-alert" }, /* @__PURE__ */ React.createElement(Loader2, { className: "dm-spin", size: 17 }), "Deleting ", summary.videos || "selected", " videos in the background. You can leave this page."), deleteStatus === "complete" && /* @__PURE__ */ React.createElement("div", { className: "dm-alert dm-success" }, /* @__PURE__ */ React.createElement(Check, { size: 17 }), "Bulk deletion finished."), rawGroups && /* @__PURE__ */ React.createElement("div", { className: "dm-result-toolbar" }, /* @__PURE__ */ React.createElement("div", { className: "dm-search" }, /* @__PURE__ */ React.createElement(Search, { size: 16 }), /* @__PURE__ */ React.createElement("input", { value: query, onChange: (event) => {
    setQuery(event.target.value);
    setPage(1);
  }, placeholder: "Filter title, path, performer, studio, tag, or codec" })), /* @__PURE__ */ React.createElement(PageSizeControl, { value: settings.pageSize, onChange: (pageSize) => updateSettings({ pageSize }) }), /* @__PURE__ */ React.createElement("button", { className: "dm-secondary", onClick: () => selectRecommended(filteredGroups) }, "Select all but keepers"), /* @__PURE__ */ React.createElement("button", { className: "dm-secondary", onClick: () => clearSelected(filteredGroups) }, "Clear selection")), rawGroups && /* @__PURE__ */ React.createElement("div", { className: "dm-summary" }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, filteredGroups.length), " groups"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, filteredGroups.reduce((sum, group) => sum + group.length, 0)), " videos"), /* @__PURE__ */ React.createElement("span", { className: "dm-summary-selected" }, /* @__PURE__ */ React.createElement("strong", null, summary.videos), " selected, ", formatBytes(summary.bytes))), rawGroups && filteredGroups.length === 0 && /* @__PURE__ */ React.createElement("div", { className: "dm-empty" }, /* @__PURE__ */ React.createElement(Check, { size: 44 }), /* @__PURE__ */ React.createElement("h2", null, "No duplicate groups"), /* @__PURE__ */ React.createElement("p", null, "Change the filters or run a different match.")), /* @__PURE__ */ React.createElement("div", { className: "dm-groups" }, visibleGroups.map((group, index) => /* @__PURE__ */ React.createElement(
    DuplicateGroup,
    {
      key: group.map((video) => video.id).join("-"),
      group,
      number: (page - 1) * settings.pageSize + index + 1,
      settings,
      matchSettings: appliedSettings || settings,
      selectedIds,
      onToggle: toggleSelected,
      onSelectRecommended: () => selectRecommended([group]),
      onDismiss: () => dismissGroup(group),
      onCompare: () => setCompareGroup(group),
      onNavigate
    }
  ))), rawGroups && filteredGroups.length > 0 && /* @__PURE__ */ React.createElement(Pagination, { page, totalPages, onChange: setPage }), summary.videos > 0 && /* @__PURE__ */ React.createElement("div", { className: "dm-delete-bar" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, summary.videos, " videos selected"), /* @__PURE__ */ React.createElement("span", null, summary.files, " files, ", formatBytes(summary.bytes))), unsafeGroups.length > 0 && /* @__PURE__ */ React.createElement("span", { className: "dm-safety" }, /* @__PURE__ */ React.createElement(AlertTriangle, { size: 15 }), "Keep at least one video in every affected group."), /* @__PURE__ */ React.createElement("button", { className: "dm-danger", disabled: unsafeGroups.length > 0 || deleteStatus === "pending", onClick: () => setConfirmOpen(true) }, /* @__PURE__ */ React.createElement(Trash2, { size: 17 }), "Delete selected")), compareGroup && /* @__PURE__ */ React.createElement(CompareDialog, { group: compareGroup, matchSettings: appliedSettings || settings, selectedIds, onToggle: toggleSelected, onClose: () => setCompareGroup(null) }), confirmOpen && /* @__PURE__ */ React.createElement(DeleteDialog, { summary, defaults: settings, onCancel: () => setConfirmOpen(false), onConfirm: confirmDelete }), folderOpen && /* @__PURE__ */ React.createElement(FolderDialog, { mode: settings.folderMode, selected: settings.includedPaths, onCancel: () => setFolderOpen(false), onApply: (paths) => {
    updateSettings({ includedPaths: paths });
    setFolderOpen(false);
  } }));
}
function DuplicateGroup({ group, number, settings, matchSettings, selectedIds, onToggle, onSelectRecommended, onDismiss, onCompare, onNavigate }) {
  const keeper = chooseKeeper(group, settings);
  return /* @__PURE__ */ React.createElement("section", { className: "dm-group" }, /* @__PURE__ */ React.createElement("header", null, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "Group ", number), /* @__PURE__ */ React.createElement("span", null, group.length, " videos")), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("button", { className: "dm-secondary", onClick: onCompare }, /* @__PURE__ */ React.createElement(Columns2, { size: 15 }), "Compare"), /* @__PURE__ */ React.createElement("button", { className: "dm-secondary", onClick: onSelectRecommended }, "Keep recommended"), /* @__PURE__ */ React.createElement("button", { className: "dm-icon-button", title: "Remove this comparison", "aria-label": "Remove this comparison", onClick: onDismiss }, /* @__PURE__ */ React.createElement(X, { size: 16 })))), /* @__PURE__ */ React.createElement("div", { className: "dm-video-grid" }, group.map((video) => /* @__PURE__ */ React.createElement(VideoCard, { key: video.id, video, reference: keeper, phashThreshold: matchSettings.matchType === "phash" ? matchSettings.phashDistance : null, selected: selectedIds.has(video.id), recommended: keeper?.id === video.id, onToggle: () => onToggle(video.id), onOpen: () => onNavigate({ page: "video", id: video.id }) }))));
}
function VideoCard({ video, reference, phashThreshold, selected, recommended, onToggle, onOpen }) {
  const file = primaryFile(video);
  const copyCount = recommended ? 0 : metadataCopyCount(reference, video);
  const [previewing, setPreviewing] = useState(false);
  return /* @__PURE__ */ React.createElement("article", { className: `dm-video-card ${selected ? "dm-selected" : ""}` }, /* @__PURE__ */ React.createElement("div", { className: "dm-media", onMouseEnter: () => setPreviewing(true), onMouseLeave: () => setPreviewing(false) }, /* @__PURE__ */ React.createElement("button", { className: `dm-check ${selected ? "dm-check-on" : ""}`, "aria-label": selected ? "Do not delete" : "Mark for deletion", onClick: onToggle }, selected && /* @__PURE__ */ React.createElement(Check, { size: 14 })), recommended && /* @__PURE__ */ React.createElement("span", { className: "dm-keeper" }, "Recommended keeper"), /* @__PURE__ */ React.createElement("img", { src: mediaUrls.screenshot(video.id, video.updatedAt), alt: "", loading: "lazy" }), previewing && /* @__PURE__ */ React.createElement("video", { src: mediaUrls.preview(video.id), autoPlay: true, muted: true, loop: true, playsInline: true, preload: "none" })), /* @__PURE__ */ React.createElement("div", { className: "dm-video-info" }, /* @__PURE__ */ React.createElement("a", { className: "dm-video-title", href: `/video/${video.id}`, onClick: (event) => {
    if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onOpen();
    }
  } }, video.title || file?.basename || `Video #${video.id}`), /* @__PURE__ */ React.createElement("div", { className: "dm-facts" }, /* @__PURE__ */ React.createElement("span", null, file ? `${file.width || 0}x${file.height || 0}` : "No file"), /* @__PURE__ */ React.createElement("span", null, file?.videoCodec || "unknown codec"), /* @__PURE__ */ React.createElement("span", null, formatDuration(file?.duration)), /* @__PURE__ */ React.createElement("span", null, formatBytes(file?.size)), /* @__PURE__ */ React.createElement("span", null, Math.round(Number(file?.bitRate || 0) / 1e3), " kbps"), /* @__PURE__ */ React.createElement("span", null, metadataCount(video), " metadata")), phashThreshold !== null && !recommended && /* @__PURE__ */ React.createElement(PhashSummary, { left: reference, right: video, threshold: phashThreshold }), copyCount > 0 && /* @__PURE__ */ React.createElement("p", { className: "dm-metadata-copy" }, /* @__PURE__ */ React.createElement(Copy, { size: 13 }), copyCount, " metadata will be copied"), /* @__PURE__ */ React.createElement("p", { className: "dm-file-path", title: file?.path }, displayPath(file?.path || "No path"))));
}
function Pagination({ page, totalPages, onChange }) {
  return /* @__PURE__ */ React.createElement("nav", { className: "dm-pagination" }, /* @__PURE__ */ React.createElement("button", { className: "dm-icon-button", disabled: page <= 1, onClick: () => onChange(page - 1) }, /* @__PURE__ */ React.createElement(ArrowLeft, { size: 17 })), /* @__PURE__ */ React.createElement("span", null, "Page ", page, " of ", totalPages), /* @__PURE__ */ React.createElement("button", { className: "dm-icon-button", disabled: page >= totalPages, onClick: () => onChange(page + 1) }, /* @__PURE__ */ React.createElement(ArrowRight, { size: 17 })));
}
function releaseMediaSource(video) {
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}
function CompareDialog({ group, matchSettings, selectedIds, onToggle, onClose }) {
  const [leftId, setLeftId] = useState(group[0].id);
  const [rightId, setRightId] = useState(group[1].id);
  const [wipe, setWipe] = useState(50);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [leftStart, setLeftStart] = useState(0);
  const [rightStart, setRightStart] = useState(0);
  const [leftSourceEpoch, setLeftSourceEpoch] = useState(0);
  const [rightSourceEpoch, setRightSourceEpoch] = useState(0);
  const [leftTranscodeActive, setLeftTranscodeActive] = useState(false);
  const [rightTranscodeActive, setRightTranscodeActive] = useState(false);
  const [leftReady, setLeftReady] = useState(false);
  const [rightReady, setRightReady] = useState(false);
  const [leftForceTranscode, setLeftForceTranscode] = useState(false);
  const [rightForceTranscode, setRightForceTranscode] = useState(false);
  const [leftResolution, setLeftResolution] = useState({ videoId: null, ready: false, candidates: [], attempt: 0 });
  const [rightResolution, setRightResolution] = useState({ videoId: null, ready: false, candidates: [], attempt: 0 });
  const [pendingPlay, setPendingPlay] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const left = group.find((video) => video.id === Number(leftId)) || group[0];
  const right = group.find((video) => video.id === Number(rightId)) || group[1];
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const stageRef = useRef(null);
  const seekTimerRef = useRef(null);
  const playRequestRef = useRef(0);
  const startingRef = useRef(false);
  const leftPlaybackBase = comparisonPlayback(left);
  const rightPlaybackBase = comparisonPlayback(right);
  const leftPlayback = { ...leftPlaybackBase, transcode: leftPlaybackBase.transcode || leftForceTranscode };
  const rightPlayback = { ...rightPlaybackBase, transcode: rightPlaybackBase.transcode || rightForceTranscode };
  const leftResolutionReady = leftResolution.videoId === left.id && leftResolution.ready;
  const rightResolutionReady = rightResolution.videoId === right.id && rightResolution.ready;
  const leftResolutionValue = leftResolution.candidates[leftResolution.attempt] ?? null;
  const rightResolutionValue = rightResolution.candidates[rightResolution.attempt] ?? null;
  const leftSource = leftPlayback.transcode ? leftTranscodeActive && leftResolutionReady ? mediaUrls.transcode(left.id, leftStart, leftResolutionValue) : null : mediaUrls.stream(left.id);
  const rightSource = rightPlayback.transcode ? rightTranscodeActive && rightResolutionReady ? mediaUrls.transcode(right.id, rightStart, rightResolutionValue) : null : mediaUrls.stream(right.id);
  const duration = Math.min(Number(primaryFile(left)?.duration || 0), Number(primaryFile(right)?.duration || 0));
  function pauseBoth() {
    const a = leftRef.current;
    const b = rightRef.current;
    a?.pause();
    b?.pause();
  }
  function localTime(absolute, start, transcoded) {
    return Math.max(0, Number(absolute || 0) - (transcoded ? Number(start || 0) : 0));
  }
  function absoluteTime(video, start, transcoded) {
    return Number(video?.currentTime || 0) + (transcoded ? Number(start || 0) : 0);
  }
  function align(video, absolute, start, transcoded) {
    if (!video || video.readyState < 1) return;
    const target = localTime(absolute, start, transcoded);
    if (Math.abs(Number(video.currentTime || 0) - target) > 0.08) video.currentTime = target;
  }
  function requestPlay() {
    if (seeking) return;
    setPlaybackError("");
    setPendingPlay(true);
    if (leftPlayback.transcode && !leftTranscodeActive) {
      setLeftReady(false);
      setLeftSourceEpoch((value) => value + 1);
      setLeftTranscodeActive(true);
    } else if (!leftPlayback.transcode) {
      setLeftReady(leftRef.current?.readyState >= 3);
    }
    if (rightPlayback.transcode && !rightTranscodeActive) {
      setRightReady(false);
      setRightSourceEpoch((value) => value + 1);
      setRightTranscodeActive(true);
    } else if (!rightPlayback.transcode) {
      setRightReady(rightRef.current?.readyState >= 3);
    }
  }
  function pause() {
    const a = leftRef.current;
    const b = rightRef.current;
    const target = playing && a ? absoluteTime(a, leftStart, leftPlayback.transcode) : time;
    playRequestRef.current++;
    pauseBoth();
    setTime(target);
    if (leftPlayback.transcode && leftTranscodeActive) {
      releaseMediaSource(a);
      setLeftReady(false);
      setLeftStart(target);
      setLeftTranscodeActive(false);
    }
    if (rightPlayback.transcode && rightTranscodeActive) {
      releaseMediaSource(b);
      setRightReady(false);
      setRightStart(target);
      setRightTranscodeActive(false);
    }
    setPendingPlay(false);
    setPlaying(false);
  }
  function seek(value) {
    const next = Math.max(0, Math.min(duration || 0, Number(value)));
    const resume = playing || pendingPlay;
    playRequestRef.current++;
    pauseBoth();
    setPlaying(false);
    setPendingPlay(resume);
    setTime(next);
    setSeeking(true);
    setLeftReady(false);
    setRightReady(false);
    setPlaybackError("");
    clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => {
      const a = leftRef.current;
      const b = rightRef.current;
      if (leftPlayback.transcode) {
        releaseMediaSource(a);
        setLeftReady(false);
        setLeftTranscodeActive(false);
      } else {
        align(a, next, 0, false);
        setLeftReady(a?.readyState >= 3);
      }
      if (rightPlayback.transcode) {
        releaseMediaSource(b);
        setRightReady(false);
        setRightTranscodeActive(false);
      } else {
        align(b, next, 0, false);
        setRightReady(b?.readyState >= 3);
      }
      seekTimerRef.current = setTimeout(() => {
        if (leftPlayback.transcode) {
          setLeftStart(next);
          if (resume) {
            setLeftSourceEpoch((value2) => value2 + 1);
            setLeftTranscodeActive(true);
          }
        }
        if (rightPlayback.transcode) {
          setRightStart(next);
          if (resume) {
            setRightSourceEpoch((value2) => value2 + 1);
            setRightTranscodeActive(true);
          }
        }
        setSeeking(false);
      }, 75);
    }, 120);
  }
  function markWaiting(side) {
    if (side === "left") setLeftReady(false);
    else setRightReady(false);
    if (playing || pendingPlay) {
      pauseBoth();
      setPlaying(false);
      setPendingPlay(true);
    }
  }
  function handleLeftTimeUpdate(event) {
    if (!playing) return;
    const absolute = absoluteTime(event.currentTarget, leftStart, leftPlayback.transcode);
    setTime(absolute);
    const other = rightRef.current;
    const otherAbsolute = absoluteTime(other, rightStart, rightPlayback.transcode);
    if (other?.readyState >= 2 && Math.abs(absolute - otherAbsolute) > 0.2) {
      align(other, absolute, rightStart, rightPlayback.transcode);
    }
  }
  function handleMediaError(side) {
    const isLeft = side === "left";
    const playback = isLeft ? leftPlayback : rightPlayback;
    const video = isLeft ? leftRef.current : rightRef.current;
    const start = isLeft ? leftStart : rightStart;
    const absolute = absoluteTime(video, start, playback.transcode);
    if (!playback.transcode) {
      const resume = playing || pendingPlay;
      playRequestRef.current++;
      pauseBoth();
      releaseMediaSource(video);
      setPlaying(false);
      setPendingPlay(resume);
      if (isLeft) {
        setLeftReady(false);
        setLeftStart(absolute);
        setLeftForceTranscode(true);
        setLeftTranscodeActive(resume);
      } else {
        setRightReady(false);
        setRightStart(absolute);
        setRightForceTranscode(true);
        setRightTranscodeActive(resume);
      }
      return;
    }
    const resolution = isLeft ? leftResolution : rightResolution;
    if (resolution.attempt + 1 < resolution.candidates.length) {
      const resume = playing || pendingPlay;
      playRequestRef.current++;
      pauseBoth();
      setPlaying(false);
      setPendingPlay(resume);
      setTime(absolute);
      setPlaybackError("");
      if (isLeft) {
        setLeftReady(false);
        setLeftResolution((current) => ({ ...current, attempt: current.attempt + 1 }));
        setLeftSourceEpoch((value) => value + 1);
      } else {
        setRightReady(false);
        setRightResolution((current) => ({ ...current, attempt: current.attempt + 1 }));
        setRightSourceEpoch((value) => value + 1);
      }
      return;
    }
    pause();
    setPlaybackError(`Video ${isLeft ? "A" : "B"} could not be transcoded. Check Cove's FFmpeg settings.`);
  }
  function moveWipe(event) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setWipe(Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100)));
  }
  function startWipe(event) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    moveWipe(event);
  }
  useEffect(() => {
    pauseBoth();
    playRequestRef.current++;
    setPlaying(false);
    setPendingPlay(false);
    setSeeking(false);
    setTime(0);
    setLeftStart(0);
    setRightStart(0);
    setLeftSourceEpoch(0);
    setRightSourceEpoch(0);
    setLeftTranscodeActive(false);
    setRightTranscodeActive(false);
    setLeftReady(false);
    setRightReady(false);
    setLeftForceTranscode(false);
    setRightForceTranscode(false);
    setPlaybackError("");
  }, [leftId, rightId]);
  useEffect(() => {
    if (!leftPlayback.transcode) return;
    let cancelled = false;
    setLeftResolution({ videoId: left.id, ready: false, candidates: [], attempt: 0 });
    loadTranscodeResolutions(left.id).then((values) => {
      if (!cancelled) setLeftResolution({ videoId: left.id, ready: true, candidates: transcodeResolutionCandidates(values), attempt: 0 });
    }).catch(() => {
      if (!cancelled) setLeftResolution({ videoId: left.id, ready: true, candidates: [null], attempt: 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [left.id, leftPlayback.transcode]);
  useEffect(() => {
    if (!rightPlayback.transcode) return;
    let cancelled = false;
    setRightResolution({ videoId: right.id, ready: false, candidates: [], attempt: 0 });
    loadTranscodeResolutions(right.id).then((values) => {
      if (!cancelled) setRightResolution({ videoId: right.id, ready: true, candidates: transcodeResolutionCandidates(values), attempt: 0 });
    }).catch(() => {
      if (!cancelled) setRightResolution({ videoId: right.id, ready: true, candidates: [null], attempt: 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [right.id, rightPlayback.transcode]);
  useEffect(() => {
    if (!pendingPlay || !leftReady || !rightReady || startingRef.current) return;
    const a = leftRef.current;
    const b = rightRef.current;
    if (!a || !b) return;
    const request2 = ++playRequestRef.current;
    startingRef.current = true;
    align(a, time, leftStart, leftPlayback.transcode);
    align(b, time, rightStart, rightPlayback.transcode);
    Promise.all([a.play(), b.play()]).then(() => {
      if (request2 !== playRequestRef.current) return;
      setPendingPlay(false);
      setPlaying(true);
    }).catch((reason) => {
      if (request2 !== playRequestRef.current) return;
      pauseBoth();
      setPendingPlay(false);
      setPlaying(false);
      setPlaybackError(reason?.message || "The comparison could not start playback.");
    }).finally(() => {
      startingRef.current = false;
    });
  }, [pendingPlay, leftReady, rightReady, time, leftStart, rightStart, leftId, rightId]);
  useEffect(() => () => {
    clearTimeout(seekTimerRef.current);
    playRequestRef.current++;
    for (const video of [leftRef.current, rightRef.current]) {
      if (!video) continue;
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }, []);
  return /* @__PURE__ */ React.createElement(Modal, { title: "Compare duplicates", onClose, wide: true }, /* @__PURE__ */ React.createElement("div", { className: "dm-compare-selects" }, /* @__PURE__ */ React.createElement("label", null, "Video A", /* @__PURE__ */ React.createElement("select", { value: left.id, onChange: (event) => {
    releaseMediaSource(leftRef.current);
    setLeftTranscodeActive(false);
    setLeftForceTranscode(false);
    setLeftId(Number(event.target.value));
  } }, group.filter((video) => video.id !== right.id).map((video) => /* @__PURE__ */ React.createElement("option", { key: video.id, value: video.id }, video.title || primaryFile(video)?.basename || `Video #${video.id}`)))), /* @__PURE__ */ React.createElement("label", null, "Video B", /* @__PURE__ */ React.createElement("select", { value: right.id, onChange: (event) => {
    releaseMediaSource(rightRef.current);
    setRightTranscodeActive(false);
    setRightForceTranscode(false);
    setRightId(Number(event.target.value));
  } }, group.filter((video) => video.id !== left.id).map((video) => /* @__PURE__ */ React.createElement("option", { key: video.id, value: video.id }, video.title || primaryFile(video)?.basename || `Video #${video.id}`))))), /* @__PURE__ */ React.createElement("div", { className: "dm-compare-stage", ref: stageRef }, /* @__PURE__ */ React.createElement("video", { key: `${left.id}-${leftPlayback.transcode ? `${leftStart}-${leftResolutionValue || "source"}-${leftSourceEpoch}` : "direct"}`, ref: leftRef, src: leftSource || void 0, muted: true, playsInline: true, preload: leftPlayback.transcode ? "auto" : "metadata", onCanPlay: () => setLeftReady(true), onWaiting: () => markWaiting("left"), onTimeUpdate: handleLeftTimeUpdate, onError: () => handleMediaError("left"), onEnded: () => pause() }), /* @__PURE__ */ React.createElement("div", { className: "dm-compare-overlay", style: { clipPath: `inset(0 0 0 ${wipe}%)` } }, /* @__PURE__ */ React.createElement("video", { key: `${right.id}-${rightPlayback.transcode ? `${rightStart}-${rightResolutionValue || "source"}-${rightSourceEpoch}` : "direct"}`, ref: rightRef, src: rightSource || void 0, muted: true, playsInline: true, preload: rightPlayback.transcode ? "auto" : "metadata", onCanPlay: () => setRightReady(true), onWaiting: () => markWaiting("right"), onError: () => handleMediaError("right") })), /* @__PURE__ */ React.createElement("span", { className: "dm-label-a" }, "A"), /* @__PURE__ */ React.createElement("span", { className: "dm-label-b" }, "B"), /* @__PURE__ */ React.createElement("button", { className: "dm-wipe-handle", "aria-label": "Drag to compare videos", title: "Drag to compare", style: { left: `${wipe}%` }, onPointerDown: startWipe, onPointerMove: (event) => event.currentTarget.hasPointerCapture(event.pointerId) && moveWipe(event) }, /* @__PURE__ */ React.createElement("span", null))), playbackError && /* @__PURE__ */ React.createElement("div", { className: "dm-alert dm-error" }, /* @__PURE__ */ React.createElement(AlertTriangle, { size: 16 }), /* @__PURE__ */ React.createElement("span", null, playbackError)), /* @__PURE__ */ React.createElement("div", { className: "dm-compare-controls" }, /* @__PURE__ */ React.createElement("button", { className: "dm-icon-button", disabled: seeking, onClick: () => playing || pendingPlay ? pause() : requestPlay() }, playing ? /* @__PURE__ */ React.createElement(Pause, { size: 18 }) : pendingPlay || seeking ? /* @__PURE__ */ React.createElement(Loader2, { className: "dm-spin", size: 18 }) : /* @__PURE__ */ React.createElement(Play, { size: 18 })), /* @__PURE__ */ React.createElement("span", null, formatDuration(time)), /* @__PURE__ */ React.createElement("input", { type: "range", min: "0", max: Math.max(duration, 1), step: "0.1", value: Math.min(time, duration || 1), onChange: (event) => seek(event.target.value) }), /* @__PURE__ */ React.createElement("span", null, formatDuration(duration)), seeking ? /* @__PURE__ */ React.createElement("span", null, "Setting seek point") : pendingPlay && (!leftReady || !rightReady) && /* @__PURE__ */ React.createElement("span", null, "Preparing playback")), matchSettings.matchType === "phash" && /* @__PURE__ */ React.createElement("div", { className: "dm-compare-phash" }, /* @__PURE__ */ React.createElement(PhashSummary, { left, right, threshold: matchSettings.phashDistance })), /* @__PURE__ */ React.createElement("div", { className: "dm-compare-details" }, /* @__PURE__ */ React.createElement(CompareDetails, { label: "A", video: left, selected: selectedIds.has(left.id), onToggle: () => onToggle(left.id) }), /* @__PURE__ */ React.createElement(CompareDetails, { label: "B", video: right, selected: selectedIds.has(right.id), onToggle: () => onToggle(right.id) })));
}
function CompareDetails({ label, video, selected, onToggle }) {
  const file = primaryFile(video);
  return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, label, ": ", video.title || file?.basename || `Video #${video.id}`), /* @__PURE__ */ React.createElement("p", null, file?.width || 0, "x", file?.height || 0, " \xB7 ", file?.videoCodec || "unknown", " \xB7 ", Math.round(Number(file?.bitRate || 0) / 1e3), " kbps \xB7 ", formatBytes(file?.size), " \xB7 ", metadataCount(video), " metadata"), /* @__PURE__ */ React.createElement("p", { className: "dm-file-path", title: file?.path }, displayPath(file?.path)), /* @__PURE__ */ React.createElement("label", { className: "dm-compare-delete" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: selected, onChange: onToggle }), "Mark for deletion"));
}
function PhashSummary({ left, right, threshold }) {
  if (!left || !right) return null;
  const comparison = phashComparison(left, right, threshold);
  const rows = [
    ["pHash distance", comparison.phash],
    ["Size difference", comparison.size],
    ["Resolution", comparison.resolution],
    ["Codec", comparison.codec],
    ["Duration", comparison.duration]
  ];
  return /* @__PURE__ */ React.createElement("div", { className: "dm-phash-summary" }, rows.map(([label, result]) => /* @__PURE__ */ React.createElement("div", { key: label, className: result.matches ? "dm-match" : "dm-mismatch" }, result.matches ? /* @__PURE__ */ React.createElement(Check, { size: 13 }) : /* @__PURE__ */ React.createElement(X, { size: 13 }), /* @__PURE__ */ React.createElement("span", null, label, ": ", result.value))));
}
function DeleteDialog({ summary, defaults, onCancel, onConfirm }) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleteGenerated, setDeleteGenerated] = useState(true);
  const [copyMetadata, setCopyMetadata] = useState(defaults.copyMissingMetadata);
  const [overwriteMetadata, setOverwriteMetadata] = useState(defaults.overwriteConflictingMetadata);
  return /* @__PURE__ */ React.createElement(Modal, { title: "Delete selected duplicates", onClose: onCancel }, /* @__PURE__ */ React.createElement("p", { className: "dm-dialog-message" }, "Delete ", summary.videos, " video records affecting ", summary.files, " files (", formatBytes(summary.bytes), ")? At least one video will remain in each affected group."), /* @__PURE__ */ React.createElement("label", { className: "dm-checkbox-row" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: deleteFiles, onChange: (event) => setDeleteFiles(event.target.checked) }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, "Delete source file from disk (this will permanently remove the file)"), /* @__PURE__ */ React.createElement("small", null, "This cannot be undone."))), /* @__PURE__ */ React.createElement("label", { className: "dm-checkbox-row" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: deleteGenerated, onChange: (event) => setDeleteGenerated(event.target.checked) }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, "Delete generated files"), /* @__PURE__ */ React.createElement("small", null, "Remove Cove thumbnails, previews, sprites, and other generated artifacts."))), /* @__PURE__ */ React.createElement("label", { className: "dm-checkbox-row" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: copyMetadata, onChange: (event) => setCopyMetadata(event.target.checked) }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, "Copy missing metadata from deleted files"), /* @__PURE__ */ React.createElement("small", null, "Merge titles, editable metadata, relationships, and markers before deletion."))), /* @__PURE__ */ React.createElement("label", { className: "dm-checkbox-row" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: overwriteMetadata, disabled: !copyMetadata, onChange: (event) => setOverwriteMetadata(event.target.checked) }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, "Overwrite conflicting metadata"), /* @__PURE__ */ React.createElement("small", null, "Prefer metadata from deleted files when both videos have a value."))), /* @__PURE__ */ React.createElement("div", { className: "dm-dialog-actions" }, /* @__PURE__ */ React.createElement("button", { className: "dm-secondary", onClick: onCancel }, "Cancel"), /* @__PURE__ */ React.createElement("button", { className: "dm-danger", onClick: () => onConfirm({ deleteFiles, deleteGenerated, copyMetadata, overwriteConflictingMetadata: copyMetadata && overwriteMetadata }) }, /* @__PURE__ */ React.createElement(Trash2, { size: 16 }), "Delete ", summary.videos, " videos")));
}
function FolderScopeControl({ settings, onChange, onPick, settingsView = false }) {
  const setMode = (folderMode) => onChange(folderMode === "all" ? { folderMode, includedPaths: [] } : { folderMode });
  return /* @__PURE__ */ React.createElement("div", { className: `dm-folder-scope ${settingsView ? "dm-folder-scope-settings" : ""}` }, /* @__PURE__ */ React.createElement("div", { className: "dm-folder-modes", role: "group", "aria-label": "Folder mode" }, [["all", "All"], ["include", "Include"], ["exclude", "Exclude"]].map(([mode, label]) => /* @__PURE__ */ React.createElement("button", { key: mode, type: "button", className: settings.folderMode === mode ? "dm-folder-mode-active" : "", "aria-pressed": settings.folderMode === mode, onClick: () => setMode(mode) }, label))), /* @__PURE__ */ React.createElement("button", { type: "button", className: "dm-secondary dm-folder-button", disabled: settings.folderMode === "all", onClick: onPick }, /* @__PURE__ */ React.createElement(Folder, { size: 16 }), settings.folderMode === "all" ? "All folders" : settings.includedPaths.length ? `${settings.includedPaths.length} folders` : "Choose folders"));
}
function FolderDialog({ mode, selected, onCancel, onApply }) {
  const [paths, setPaths] = useState([...selected]);
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    loadFolders().then(setRoots).catch((reason) => setError(reason.message || "Could not load folders.")).finally(() => setLoading(false));
  }, []);
  function toggle(path) {
    setPaths((values) => values.includes(path) ? values.filter((value) => value !== path) : [...values, path]);
  }
  return /* @__PURE__ */ React.createElement(Modal, { title: `${mode === "exclude" ? "Exclude" : "Include"} folders`, onClose: onCancel }, /* @__PURE__ */ React.createElement("div", { className: "dm-folder-heading" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, mode === "exclude" ? "Excluded folders" : "Included folders"), /* @__PURE__ */ React.createElement("p", null, "Select one or more library folders.")), paths.length > 0 && /* @__PURE__ */ React.createElement("button", { onClick: () => setPaths([]) }, "Clear")), /* @__PURE__ */ React.createElement("div", { className: "dm-folder-tree" }, loading ? /* @__PURE__ */ React.createElement("p", null, /* @__PURE__ */ React.createElement(Loader2, { className: "dm-spin", size: 15 }), "Loading folders") : error ? /* @__PURE__ */ React.createElement("p", { className: "dm-folder-error" }, error) : roots.map((entry) => /* @__PURE__ */ React.createElement(FolderNode, { key: entry.path, entry, depth: 0, selected: paths, onToggle: toggle }))), /* @__PURE__ */ React.createElement("div", { className: "dm-dialog-actions" }, /* @__PURE__ */ React.createElement("button", { className: "dm-secondary", onClick: onCancel }, "Cancel"), /* @__PURE__ */ React.createElement("button", { className: "dm-primary", onClick: () => onApply(paths) }, /* @__PURE__ */ React.createElement(Check, { size: 16 }), "Apply")));
}
function FolderNode({ entry, depth, selected, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState(null);
  const [loading, setLoading] = useState(false);
  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next && entry.hasChildren && children === null) {
      setLoading(true);
      loadFolders(entry.path).then(setChildren).catch(() => setChildren([])).finally(() => setLoading(false));
    }
  }
  return /* @__PURE__ */ React.createElement("div", { className: "dm-folder-node" }, /* @__PURE__ */ React.createElement("div", { className: "dm-folder-row", style: { paddingLeft: `${depth * 16 + 4}px` } }, entry.hasChildren ? /* @__PURE__ */ React.createElement("button", { "aria-label": expanded ? "Collapse folder" : "Expand folder", onClick: toggleExpanded }, expanded ? /* @__PURE__ */ React.createElement(ChevronDown, { size: 14 }) : /* @__PURE__ */ React.createElement(ChevronRight, { size: 14 })) : /* @__PURE__ */ React.createElement("span", { className: "dm-folder-spacer" }), /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: selected.includes(entry.path), onChange: () => onToggle(entry.path) }), /* @__PURE__ */ React.createElement("span", { title: entry.path }, entry.name || entry.path))), expanded && (loading ? /* @__PURE__ */ React.createElement("p", { className: "dm-folder-child-status", style: { paddingLeft: `${depth * 16 + 38}px` } }, "Loading...") : (children || []).map((child) => /* @__PURE__ */ React.createElement(FolderNode, { key: child.path, entry: child, depth: depth + 1, selected, onToggle }))));
}
function PageSizeControl({ value, onChange, settingsLabel = false }) {
  const presets = [10, 25, 50, 100];
  const custom = !presets.includes(Number(value));
  return /* @__PURE__ */ React.createElement("div", { className: `dm-page-size ${settingsLabel ? "dm-page-size-settings" : ""}` }, settingsLabel && /* @__PURE__ */ React.createElement("span", null, "Groups per page"), /* @__PURE__ */ React.createElement("select", { "aria-label": "Groups per page", value: custom ? "custom" : String(value), onChange: (event) => onChange(event.target.value === "custom" ? 250 : Number(event.target.value)) }, presets.map((size) => /* @__PURE__ */ React.createElement("option", { key: size, value: size }, size, settingsLabel ? "" : " groups")), /* @__PURE__ */ React.createElement("option", { value: "custom" }, "Custom")), custom && /* @__PURE__ */ React.createElement("input", { "aria-label": "Custom groups per page", type: "number", min: "1", max: "10000", value, onChange: (event) => onChange(Math.max(1, Math.min(1e4, Number(event.target.value) || 1))) }));
}
function DurationInput({ label, value, onChange }) {
  const [text, setText] = useState(formatDurationInput(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(formatDurationInput(value));
  }, [value]);
  function commit() {
    const parsed = parseDurationInput(text);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(parsed);
    setText(formatDurationInput(parsed));
  }
  return /* @__PURE__ */ React.createElement("label", { className: invalid ? "dm-duration-invalid" : "" }, /* @__PURE__ */ React.createElement("span", null, label), /* @__PURE__ */ React.createElement("input", { type: "text", inputMode: "numeric", value: text, placeholder: "0:00", title: "Seconds, MM:SS, or HH:MM:SS", onChange: (event) => setText(event.target.value), onBlur: commit, onKeyDown: (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  } }));
}
function Modal({ title, onClose, wide, children }) {
  return /* @__PURE__ */ React.createElement("div", { className: "dm-modal-backdrop", role: "presentation", onMouseDown: (event) => {
    if (event.target === event.currentTarget) onClose();
  } }, /* @__PURE__ */ React.createElement("div", { className: `dm-modal ${wide ? "dm-modal-wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title }, /* @__PURE__ */ React.createElement("header", null, /* @__PURE__ */ React.createElement("h2", null, title), /* @__PURE__ */ React.createElement("button", { className: "dm-icon-button", onClick: onClose }, /* @__PURE__ */ React.createElement(X, { size: 18 }))), children));
}
function DuplicateManagerSettingsPanel() {
  const [settings, setSettings] = useState(normalizeSettings(DEFAULT_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  useEffect(() => {
    loadSettings().then((value) => setSettings(normalizeSettings(value))).catch((reason) => setMessage(reason.message)).finally(() => setLoading(false));
  }, []);
  function update(patch) {
    setSettings((current) => normalizeSettings({ ...current, ...patch }));
  }
  function moveRule(index, delta) {
    const rules = [...settings.keeperRules];
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    [rules[index], rules[target]] = [rules[target], rules[index]];
    update({ keeperRules: rules });
  }
  function removeRule(index) {
    update({ keeperRules: settings.keeperRules.filter((_, itemIndex) => itemIndex !== index) });
  }
  async function save() {
    setSaving(true);
    setMessage("");
    try {
      setSettings(normalizeSettings(await saveSettings(settings)));
      setMessage("Settings saved.");
    } catch (reason) {
      setMessage(reason.message);
    } finally {
      setSaving(false);
    }
  }
  if (loading) return /* @__PURE__ */ React.createElement("div", { className: "dm-settings-loading" }, /* @__PURE__ */ React.createElement(Loader2, { className: "dm-spin" }), "Loading Duplicate Manager settings");
  const availableRules = Object.keys(RULE_LABELS).filter((rule) => !settings.keeperRules.includes(rule));
  return /* @__PURE__ */ React.createElement("div", { className: "dm-settings" }, /* @__PURE__ */ React.createElement("div", { className: "dm-settings-heading" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h3", null, /* @__PURE__ */ React.createElement(Settings2, { size: 19 }), "Duplicate Manager"), /* @__PURE__ */ React.createElement("p", null, "Defaults used when the improved Duplicate Finder opens.")), /* @__PURE__ */ React.createElement("button", { className: "dm-primary", disabled: saving, onClick: save }, saving ? /* @__PURE__ */ React.createElement(Loader2, { className: "dm-spin", size: 16 }) : /* @__PURE__ */ React.createElement(Save, { size: 16 }), "Save")), /* @__PURE__ */ React.createElement("div", { className: "dm-settings-grid" }, /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, "Default match type"), /* @__PURE__ */ React.createElement("select", { value: settings.matchType, onChange: (event) => update({ matchType: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "fingerprint" }, "Exact fingerprint"), /* @__PURE__ */ React.createElement("option", { value: "phash" }, "Visual pHash"), /* @__PURE__ */ React.createElement("option", { value: "title" }, "Same title"), /* @__PURE__ */ React.createElement("option", { value: "remoteid" }, "Same remote ID"))), /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, "Exact algorithm"), /* @__PURE__ */ React.createElement("select", { value: settings.fingerprintAlgorithm, onChange: (event) => update({ fingerprintAlgorithm: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "any" }, "MD5 or OSHash"), /* @__PURE__ */ React.createElement("option", { value: "md5" }, "MD5"), /* @__PURE__ */ React.createElement("option", { value: "oshash" }, "OSHash"))), /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, "Maximum pHash distance"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "0", max: "64", value: settings.phashDistance, onChange: (event) => update({ phashDistance: Number(event.target.value) }) })), /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, "Duration delta"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "0", value: settings.maxDurationDelta, onChange: (event) => update({ maxDurationDelta: Number(event.target.value) }) })), /* @__PURE__ */ React.createElement(DurationInput, { label: "Minimum length", value: settings.minimumDuration, onChange: (minimumDuration) => update({ minimumDuration }) }), /* @__PURE__ */ React.createElement(PageSizeControl, { settingsLabel: true, value: settings.pageSize, onChange: (pageSize) => update({ pageSize }) })), /* @__PURE__ */ React.createElement("section", null, /* @__PURE__ */ React.createElement("h4", null, "Preferred codecs"), /* @__PURE__ */ React.createElement("p", null, "Best to worst, separated by commas."), /* @__PURE__ */ React.createElement("input", { value: settings.preferredCodecs.join(", "), onChange: (event) => update({ preferredCodecs: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) }) })), /* @__PURE__ */ React.createElement("section", null, /* @__PURE__ */ React.createElement("h4", null, "Default folder scope"), /* @__PURE__ */ React.createElement("p", null, "Search all folders, only selected folders, or everything except selected folders."), /* @__PURE__ */ React.createElement(FolderScopeControl, { settings, onChange: update, onPick: () => setFolderOpen(true), settingsView: true })), /* @__PURE__ */ React.createElement("section", null, /* @__PURE__ */ React.createElement("h4", null, "Metadata transfer"), /* @__PURE__ */ React.createElement("p", null, "Defaults used when confirming bulk deletion."), /* @__PURE__ */ React.createElement("label", { className: "dm-checkbox-row" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: settings.copyMissingMetadata, onChange: (event) => update({ copyMissingMetadata: event.target.checked }) }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, "Copy missing metadata from deleted files"), /* @__PURE__ */ React.createElement("small", null, "Merge missing editable metadata, relationships, ratings, markers, and cover artwork into the keeper."))), /* @__PURE__ */ React.createElement("label", { className: "dm-checkbox-row" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: settings.overwriteConflictingMetadata, disabled: !settings.copyMissingMetadata, onChange: (event) => update({ overwriteConflictingMetadata: event.target.checked }) }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, "Overwrite conflicting metadata"), /* @__PURE__ */ React.createElement("small", null, "Prefer metadata from deleted files when both videos have a value.")))), /* @__PURE__ */ React.createElement("section", null, /* @__PURE__ */ React.createElement("h4", null, "Keeper priority"), /* @__PURE__ */ React.createElement("p", null, "Rules are evaluated top to bottom. The first difference determines the recommended keeper."), /* @__PURE__ */ React.createElement("div", { className: "dm-rule-list" }, settings.keeperRules.map((rule, index) => /* @__PURE__ */ React.createElement("div", { key: rule }, /* @__PURE__ */ React.createElement("span", null, index + 1, ". ", RULE_LABELS[rule]), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("button", { className: "dm-icon-button", disabled: index === 0, onClick: () => moveRule(index, -1) }, /* @__PURE__ */ React.createElement(ArrowUp, { size: 15 })), /* @__PURE__ */ React.createElement("button", { className: "dm-icon-button", disabled: index === settings.keeperRules.length - 1, onClick: () => moveRule(index, 1) }, /* @__PURE__ */ React.createElement(ArrowDown, { size: 15 })), /* @__PURE__ */ React.createElement("button", { className: "dm-icon-button", onClick: () => removeRule(index) }, /* @__PURE__ */ React.createElement(X, { size: 15 })))))), availableRules.length > 0 && /* @__PURE__ */ React.createElement("select", { value: "", onChange: (event) => event.target.value && update({ keeperRules: [...settings.keeperRules, event.target.value] }) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Add tie-break rule..."), availableRules.map((rule) => /* @__PURE__ */ React.createElement("option", { key: rule, value: rule }, RULE_LABELS[rule])))), message && /* @__PURE__ */ React.createElement("div", { className: `dm-alert ${message === "Settings saved." ? "dm-success" : "dm-error"}` }, message), folderOpen && /* @__PURE__ */ React.createElement(FolderDialog, { mode: settings.folderMode, selected: settings.includedPaths, onCancel: () => setFolderOpen(false), onApply: (includedPaths) => {
    update({ includedPaths });
    setFolderOpen(false);
  } }));
}
var index_default = { components: { DuplicateManagerPage, DuplicateManagerSettingsPanel } };
function groupKey(group) {
  return (group || []).map((video) => Number(video.id)).sort((a, b) => a - b).join("-");
}
export {
  DuplicateManagerPage,
  DuplicateManagerSettingsPanel,
  index_default as default
};
