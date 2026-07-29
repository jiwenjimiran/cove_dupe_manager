export const DEFAULT_SETTINGS = Object.freeze({
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
});

const SEARCH_PARAM_NAMES = Object.freeze([
  "match", "algorithm", "maxDistance", "durationDelta", "minLength", "folderMode", "folder", "groups", "page",
]);

// Keep this aligned with Cove's VideoPlayer compatibility fallback. These containers are
// attempted directly; an actual browser media error can still retry that side through FFmpeg.
const BROWSER_NATIVE_VIDEO_FORMATS = new Set(["mp4", "m4v", "webm", "ogg", "ogv", "mpeg", "mpg", "mov"]);

const INCOMPATIBLE_AUDIO_CODECS = new Set(["ac3", "eac3", "ec3", "dts", "dtshd", "truehd", "mlp"]);

export const RULE_LABELS = Object.freeze({
  metadata: "Most metadata",
  resolution: "Highest resolution",
  duration: "Longest duration",
  codec: "Preferred codec",
  bitrate: "Highest bitrate",
  size: "Largest file",
  oldest: "Oldest file",
  newest: "Newest file",
});

export function normalizeSettings(value) {
  const incoming = value || {};
  const incomingPaths = uniqueStrings(incoming.includedPaths, []);
  const migratedDefaults = [
    ["metadata", "resolution", "codec", "bitrate", "size", "oldest"],
    ["resolution", "duration", "codec", "bitrate", "metadata", "oldest"],
    ["resolution", "codec", "duration", "bitrate", "metadata", "oldest"],
  ];
  const keeperRules = Array.isArray(incoming.keeperRules) && migratedDefaults.some((rules) => incoming.keeperRules.join("|") === rules.join("|"))
    ? DEFAULT_SETTINGS.keeperRules
    : incoming.keeperRules;
  return {
    ...DEFAULT_SETTINGS,
    ...incoming,
    matchType: ["fingerprint", "phash", "title", "remoteid"].includes(incoming.matchType) ? incoming.matchType : "fingerprint",
    fingerprintAlgorithm: ["any", "md5", "oshash"].includes(incoming.fingerprintAlgorithm) ? incoming.fingerprintAlgorithm : "any",
    phashDistance: clampNumber(incoming.phashDistance, 0, 64, 8),
    maxDurationDelta: clampNumber(incoming.maxDurationDelta, 0, 86400, 10),
    minimumDuration: clampNumber(incoming.minimumDuration, 0, 86400000, 0),
    pageSize: clampNumber(incoming.pageSize, 1, 10000, 25),
    preferredCodecs: uniqueStrings(incoming.preferredCodecs, DEFAULT_SETTINGS.preferredCodecs),
    keeperRules: uniqueStrings(keeperRules, DEFAULT_SETTINGS.keeperRules).filter((rule) => RULE_LABELS[rule]),
    folderMode: ["include", "exclude"].includes(incoming.folderMode)
      ? incoming.folderMode
      : incomingPaths.length > 0 ? "include" : "all",
    includedPaths: incomingPaths,
  };
}

export function duplicateSearchFromUrl(search) {
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
  return { hasSearchParams, settings: patch, page };
}

export function duplicateSearchToUrl(search, settings, page = 1) {
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
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function comparisonPlayback(video) {
  const file = primaryFile(video);
  const format = normalizeContainer(file?.format, file?.path || file?.basename);
  const codec = normalizeCodec(file?.videoCodec);
  const audioCodec = normalizeCodec(file?.audioCodec);
  return {
    // Cove retains Direct for an unknown format and lets the media error fallback decide.
    transcode: Boolean(format && !BROWSER_NATIVE_VIDEO_FORMATS.has(format)) || INCOMPATIBLE_AUDIO_CODECS.has(audioCodec),
    format,
    codec,
  };
}

export function prepareGroups(apiGroups, options) {
  const settings = normalizeSettings(options);
  const paths = settings.includedPaths.map(normalizePath).filter(Boolean);
  const scoped = (apiGroups || [])
    .map((group) => group.filter((video) =>
      matchesFolderScope(video, paths, settings.folderMode)
      && Number(primaryFile(video)?.duration || 0) >= settings.minimumDuration))
    .filter((group) => group.length > 1);

  if (settings.matchType === "phash") return partitionPhashGroups(scoped, settings);
  if (settings.matchType !== "fingerprint") return mergeOverlappingGroups(scoped);

  const candidates = uniqueVideos(scoped.flat());
  const byFingerprint = new Map();
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

export function filterGroups(groups, query) {
  const terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return groups || [];
  return (groups || []).filter((group) => group.some((video) => {
    const haystack = searchableText(video);
    return terms.every((term) => haystack.includes(term));
  }));
}

export function chooseKeeper(group, settings) {
  const normalized = normalizeSettings(settings);
  return [...(group || [])].sort((left, right) => compareVideos(left, right, normalized))[0] || null;
}

export function autoSelectForDeletion(groups, settings) {
  const selected = new Set();
  for (const group of groups || []) {
    const keeper = chooseKeeper(group, settings);
    for (const video of group) if (!keeper || video.id !== keeper.id) selected.add(video.id);
  }
  return selected;
}

export function validateKeeperSafety(groups, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  return (groups || [])
    .map((group, index) => ({ index, group, remaining: group.filter((video) => !selected.has(video.id)) }))
    .filter((entry) => entry.group.some((video) => selected.has(video.id)) && entry.remaining.length === 0);
}

export function selectedSummary(groups, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const videos = uniqueVideos((groups || []).flat()).filter((video) => selected.has(video.id));
  const files = videos.flatMap((video) => video.files || []);
  return {
    videos: videos.length,
    files: files.length,
    bytes: files.reduce((total, file) => total + Number(file.size || 0), 0),
  };
}

export function metadataCount(video) {
  let count = 0;
  for (const key of ["title", "code", "details", "director", "date", "studioId", "studioName", "captions", "imagePath", "rating"]) {
    const value = video?.[key];
    if (value !== null && value !== undefined && value !== "" && value !== false) count++;
  }
  count += video?.tags?.length || 0;
  count += video?.performers?.length || 0;
  count += video?.urls?.length || 0;
  count += video?.remoteIds?.length || 0;
  count += Object.values(video?.customFields || {}).filter((value) => value !== null && value !== undefined && value !== "").length;
  return count;
}

export function primaryFile(video) {
  return [...(video?.files || [])].sort((a, b) => fileResolution(b) - fileResolution(a) || Number(b.size || 0) - Number(a.size || 0))[0] || null;
}

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = -1;
  do { amount /= 1024; unit++; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function displayPath(value, maxLength = 144) {
  const path = String(value || "");
  return path.length <= maxLength ? path : `${path.slice(0, Math.max(1, maxLength - 3))}...`;
}

export function parseDurationInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  const parts = text.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((part) => part >= 60)) return null;
  return parts.length === 2
    ? numbers[0] * 60 + numbers[1]
    : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

export function formatDurationInput(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function phashComparison(leftVideo, rightVideo, threshold = 0) {
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
    duration: { matches: durationDifference === 0, value: durationDifference === 0 ? "matches" : `${formatSeconds(Math.abs(durationDifference))} ${durationDifference > 0 ? "longer" : "shorter"}` },
  };
}

export function metadataCopyCount(target, source) {
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

export function buildMergedVideoUpdate(target, sources) {
  const ordered = [...(sources || [])].sort((a, b) => metadataCount(b) - metadataCount(a));
  const scalarFields = ["title", "code", "details", "director", "date", "rating", "studioId", "captions", "organized", "isVr"];
  const update = {};
  for (const field of scalarFields) update[field] = firstPopulated(target?.[field], ...ordered.map((item) => item?.[field]));
  update.urls = uniquePrimitive([...(target?.urls || []), ...ordered.flatMap((item) => item?.urls || [])]);
  update.tagIds = uniqueIds([...(target?.tags || []), ...ordered.flatMap((item) => item?.tags || [])]);
  update.performerIds = uniqueIds([...(target?.performers || []), ...ordered.flatMap((item) => item?.performers || [])]);
  update.galleryIds = uniqueIds([...(target?.galleries || []), ...ordered.flatMap((item) => item?.galleries || [])]);
  update.groups = uniqueGroups([...(target?.groups || []), ...ordered.flatMap((item) => item?.groups || [])]);
  update.remoteIds = mergeKeyed(target?.remoteIds, ordered.map((item) => item?.remoteIds));
  update.customFields = mergeKeyed(target?.customFields, ordered.map((item) => item?.customFields));
  return update;
}

export function segmentSignature(segment) {
  return [segment?.startSec, segment?.endSec, segment?.tagId, segment?.kind, segment?.refId, segment?.title]
    .map((value) => String(value ?? "")).join("|");
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
    return index < 0 ? -1000 : settings.preferredCodecs.length - index;
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
        while (value > 0n) { count += Number(value & 1n); value >>= 1n; }
        if (minimum === null || count < minimum) minimum = count;
      } catch { /* Ignore malformed pHash values. */ }
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
    output.push(...candidates.filter((cluster, index) => !candidates.some((other, otherIndex) =>
      otherIndex !== index && cluster.length < other.length && cluster.every((video) => other.some((item) => item.id === video.id)))));
  }
  return output.sort((a, b) => Number(a[0]?.id) - Number(b[0]?.id));
}

function formatBytesOneDecimal(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes.toFixed(1)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = -1;
  do { amount /= 1024; unit++; } while (amount >= 1024 && unit < units.length - 1);
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
  return value !== null && value !== undefined && (typeof value !== "string" || value.trim() !== "");
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
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function uniqueIds(values) {
  return [...new Set(values.map((value) => value?.id ?? value).filter((value) => value !== null && value !== undefined))];
}

function uniqueObjects(values) {
  const keyed = new Map();
  for (const value of values) keyed.set(JSON.stringify(value), value);
  return [...keyed.values()];
}

function uniqueGroups(values) {
  const groups = new Map();
  for (const value of values) {
    const groupId = Number(value?.groupId ?? value?.id ?? 0);
    if (groupId > 0 && !groups.has(groupId)) groups.set(groupId, { groupId, videoIndex: Number(value?.videoIndex || 0) });
  }
  return [...groups.values()];
}

function mergeKeyed(primary, fallbacks) {
  if (Array.isArray(primary) || (fallbacks || []).some(Array.isArray)) return uniqueObjects([...(primary || []), ...(fallbacks || []).flatMap((value) => value || [])]);
  return Object.assign({}, ...(fallbacks || []).slice().reverse().filter(Boolean), primary || {});
}

function phashes(video) {
  return (video?.files || []).flatMap((file) => file.fingerprints || [])
    .filter((fingerprint) => String(fingerprint.type || "").toLowerCase() === "phash")
    .map((fingerprint) => String(fingerprint.value || "").trim().replace(/^0x/i, ""))
    .filter((value) => /^[0-9a-f]+$/i.test(value));
}

function searchableText(video) {
  return [
    video?.title, video?.code, video?.details, video?.director, video?.studioName,
    ...(video?.tags || []).flatMap((item) => [item?.name, item]),
    ...(video?.performers || []).flatMap((item) => [item?.name, item]),
    ...(video?.files || []).flatMap((file) => [file.path, file.basename, file.videoCodec, file.audioCodec, file.format]),
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
