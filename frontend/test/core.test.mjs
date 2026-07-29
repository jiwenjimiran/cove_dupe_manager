import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  autoSelectForDeletion,
  buildMergedVideoUpdate,
  chooseKeeper,
  comparisonPlayback,
  displayPath,
  duplicateSearchFromUrl,
  duplicateSearchToUrl,
  filterGroups,
  metadataCopyCount,
  metadataCount,
  normalizeSettings,
  parseDurationInput,
  phashComparison,
  prepareGroups,
  selectedSummary,
  validateKeeperSafety,
} from "../src/core.js";

function video(id, options = {}) {
  return {
    id,
    title: options.title || `Video ${id}`,
    details: options.details,
    studioName: options.studioName,
    tags: options.tags || [],
    performers: options.performers || [],
    files: [{
      id: id * 10,
      path: options.path || `C:/library/video-${id}.mp4`,
      basename: `video-${id}.mp4`,
      width: options.width ?? 1920,
      height: options.height ?? 1080,
      size: options.size ?? 1000,
      bitRate: options.bitRate ?? 5000,
      duration: options.duration ?? 60,
      videoCodec: options.codec || "h264",
      audioCodec: options.audioCodec || "aac",
      format: options.format || "mp4",
      modTime: options.modTime || "2025-01-01T00:00:00Z",
      fingerprints: options.fingerprints || [],
    }],
  };
}

const fp = (type, value) => ({ type, value });

test("normalizes settings and supports custom page sizes", () => {
  const result = normalizeSettings({ matchType: "bad", phashDistance: 99, pageSize: 1000, includedPaths: ["D:/Media"] });
  assert.equal(result.matchType, "fingerprint");
  assert.equal(result.phashDistance, 64);
  assert.equal(result.pageSize, 1000);
  assert.deepEqual(result.includedPaths, ["D:/Media"]);
  assert.deepEqual(normalizeSettings({ keeperRules: ["metadata", "resolution", "codec", "bitrate", "size", "oldest"] }).keeperRules,
    ["resolution", "codec", "bitrate", "duration", "metadata", "oldest"]);
  assert.deepEqual(normalizeSettings({ keeperRules: ["resolution", "duration", "codec", "bitrate", "metadata", "oldest"] }).keeperRules,
    ["resolution", "codec", "bitrate", "duration", "metadata", "oldest"]);
  assert.deepEqual(normalizeSettings({ keeperRules: ["resolution", "codec", "duration", "bitrate", "metadata", "oldest"] }).keeperRules,
    ["resolution", "codec", "bitrate", "duration", "metadata", "oldest"]);
});

test("normalizes all Cove duplicate match types", () => {
  assert.equal(normalizeSettings({ matchType: "title" }).matchType, "title");
  assert.equal(normalizeSettings({ matchType: "remoteid" }).matchType, "remoteid");
});

test("duplicate search controls round-trip through URL parameters", () => {
  const settings = normalizeSettings({
    matchType: "phash", fingerprintAlgorithm: "md5", phashDistance: 12,
    maxDurationDelta: 30, minimumDuration: 90, folderMode: "exclude",
    includedPaths: ["D:/Skip One", "E:/Skip Two"], pageSize: 1000,
  });
  const search = duplicateSearchToUrl("?unrelated=kept", settings, 7);
  const parsed = duplicateSearchFromUrl(search);
  assert.equal(parsed.hasSearchParams, true);
  assert.equal(new URLSearchParams(search).get("unrelated"), "kept");
  assert.deepEqual(normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed.settings }), settings);
  assert.equal(parsed.page, 7);
  assert.equal(duplicateSearchFromUrl("?unrelated=kept").hasSearchParams, false);
});

test("comparison playback follows Cove's container and audio compatibility policy", () => {
  assert.equal(comparisonPlayback(video(1, { format: "mp4", codec: "h264" })).transcode, false);
  assert.equal(comparisonPlayback(video(2, { format: "webm", codec: "vp9" })).transcode, false);
  assert.equal(comparisonPlayback(video(3, { format: "wmv", codec: "wmv3" })).transcode, true);
  assert.equal(comparisonPlayback(video(4, { format: "mkv", codec: "h264" })).transcode, true);
  assert.equal(comparisonPlayback(video(5, { format: "mp4", codec: "hevc" })).transcode, false);
  assert.equal(comparisonPlayback(video(6, { format: "mp4", codec: "h264", audioCodec: "ac3" })).transcode, true);
  assert.equal(comparisonPlayback(video(7, { format: "avi", codec: "mpeg4" })).transcode, true);
  assert.equal(comparisonPlayback(video(8, { format: "mov", codec: "h264" })).transcode, false);
  assert.equal(comparisonPlayback({ files: [{ path: "source-without-extension", videoCodec: "wmv3" }] }).transcode, false);
});

test("display paths are limited to 144 characters", () => {
  const longPath = `D:/${"folder/".repeat(30)}video.mp4`;
  assert.equal(displayPath(longPath).length, 144);
  assert.equal(displayPath("D:/short.mp4"), "D:/short.mp4");
});

test("minimum duration removes short members before groups are formed", () => {
  const short = video(1, { duration: 59, fingerprints: [fp("md5", "same")] });
  const longOne = video(2, { duration: 60, fingerprints: [fp("md5", "same")] });
  const longTwo = video(3, { duration: 120, fingerprints: [fp("md5", "same")] });
  const groups = prepareGroups([[short, longOne, longTwo]], { minimumDuration: 60 });
  assert.deepEqual(groups.map((group) => group.map((item) => item.id)), [[2, 3]]);
  assert.equal(prepareGroups([[short, longOne]], { minimumDuration: 60 }).length, 0);
});

test("duration input accepts seconds, MM:SS, and HH:MM:SS", () => {
  assert.equal(parseDurationInput("90"), 90);
  assert.equal(parseDurationInput("1:30"), 90);
  assert.equal(parseDurationInput("1:02:03"), 3723);
  assert.equal(parseDurationInput("1:99"), null);
});

test("pHash comparison reports distance and plainly worded file differences", () => {
  const left = video(1, { size: 1000, width: 1920, height: 1080, codec: "h264", fingerprints: [fp("phash", "0000000000000000")] });
  const right = video(2, { size: 1200, width: 1280, height: 720, duration: 75, codec: "hevc", fingerprints: [fp("phash", "0000000000000003")] });
  const result = phashComparison(left, right, 2);
  assert.deepEqual(result.phash, { matches: true, value: "2" });
  assert.equal(result.size.value, "200.0 B larger");
  assert.equal(result.resolution.value, "1920x1080 vs 1280x720");
  assert.equal(result.codec.value, "codec h264 vs codec hevc");
  assert.equal(result.duration.value, "15 seconds longer");
  assert.equal(phashComparison(right, left, 2).duration.value, "15 seconds shorter");
  assert.equal(phashComparison(left, right, 1).phash.matches, false);
});

test("pHash comparison treats duration differences displayed as zero as matches", () => {
  const left = video(1, { duration: 60 });
  const slightlyLonger = video(2, { duration: 60.04 });
  const slightlyShorter = video(3, { duration: 59.96 });

  assert.deepEqual(phashComparison(left, slightlyLonger).duration, { matches: true, value: "matches" });
  assert.deepEqual(phashComparison(left, slightlyShorter).duration, { matches: true, value: "matches" });
});

test("pHash groups never contain a pair beyond the selected threshold", () => {
  const one = video(1, { fingerprints: [fp("phash", "0000")] });
  const bridge = video(2, { fingerprints: [fp("phash", "00ff")] });
  const three = video(3, { fingerprints: [fp("phash", "ffff")] });
  const groups = prepareGroups([[one, bridge, three]], { matchType: "phash", phashDistance: 8, maxDurationDelta: 10 });
  assert.deepEqual(groups.map((group) => group.map((item) => item.id)), [[1, 2], [2, 3]]);
});

test("exact matching merges overlapping MD5 and OSHash groups transitively", () => {
  const one = video(1, { fingerprints: [fp("md5", "a")] });
  const two = video(2, { fingerprints: [fp("md5", "a"), fp("oshash", "b")] });
  const three = video(3, { fingerprints: [fp("oshash", "b")] });
  const groups = prepareGroups([[one, two], [two, three]], { matchType: "fingerprint", fingerprintAlgorithm: "any" });
  assert.deepEqual(groups.map((group) => group.map((item) => item.id)), [[1, 2, 3]]);
});

test("exact algorithm filtering excludes matches from the other algorithm", () => {
  const one = video(1, { fingerprints: [fp("md5", "same"), fp("oshash", "one")] });
  const two = video(2, { fingerprints: [fp("md5", "same"), fp("oshash", "two")] });
  assert.equal(prepareGroups([[one, two]], { fingerprintAlgorithm: "md5" }).length, 1);
  assert.equal(prepareGroups([[one, two]], { fingerprintAlgorithm: "oshash" }).length, 0);
});

test("title and remote ID groups retain API matches instead of applying pHash filtering", () => {
  const one = video(1);
  const two = video(2);
  assert.deepEqual(prepareGroups([[one, two]], { matchType: "title" }).map((group) => group.map((item) => item.id)), [[1, 2]]);
  assert.deepEqual(prepareGroups([[one, two]], { matchType: "remoteid" }).map((group) => group.map((item) => item.id)), [[1, 2]]);
});

test("folder scope requires at least two in-scope members", () => {
  const insideOne = video(1, { path: "D:/Inbox/A/one.mp4", fingerprints: [fp("md5", "x")] });
  const insideTwo = video(2, { path: "D:/Inbox/A/two.mp4", fingerprints: [fp("md5", "x")] });
  const outside = video(3, { path: "D:/Library/three.mp4", fingerprints: [fp("md5", "x")] });
  const groups = prepareGroups([[insideOne, insideTwo, outside]], { includedPaths: ["d:\\inbox\\a"] });
  assert.deepEqual(groups[0].map((item) => item.id), [1, 2]);
  assert.equal(prepareGroups([[insideOne, outside]], { includedPaths: ["D:/Inbox/A"] }).length, 0);
});

test("folder scope can exclude selected folders", () => {
  const excluded = video(1, { path: "D:/Private/one.mp4", fingerprints: [fp("md5", "x")] });
  const keptOne = video(2, { path: "D:/Library/two.mp4", fingerprints: [fp("md5", "x")] });
  const keptTwo = video(3, { path: "D:/Library/three.mp4", fingerprints: [fp("md5", "x")] });
  const groups = prepareGroups([[excluded, keptOne, keptTwo]], { folderMode: "exclude", includedPaths: ["D:/Private"] });
  assert.deepEqual(groups.map((group) => group.map((item) => item.id)), [[2, 3]]);
  assert.equal(prepareGroups([[excluded, keptOne]], { folderMode: "exclude", includedPaths: ["D:/Private"] }).length, 0);
});

test("all-folder mode does not restrict results", () => {
  const one = video(1, { path: "D:/One/one.mp4", fingerprints: [fp("md5", "x")] });
  const two = video(2, { path: "D:/Two/two.mp4", fingerprints: [fp("md5", "x")] });
  assert.equal(prepareGroups([[one, two]], { folderMode: "all", includedPaths: [] }).length, 1);
});

test("query requires every term and searches relational labels and paths", () => {
  const one = video(1, { title: "Concert", studioName: "North", performers: [{ name: "Alice" }], path: "D:/Music/live.mp4" });
  const two = video(2, { title: "Movie", studioName: "South" });
  assert.deepEqual(filterGroups([[one, two]], "alice music"), [[one, two]]);
  assert.deepEqual(filterGroups([[one, two]], "alice south"), []);
});

test("ordered keeper rules use the first differentiating rule", () => {
  const metadataRich = video(1, { details: "Known", width: 1280, height: 720, codec: "h264" });
  const highResolution = video(2, { width: 3840, height: 2160, codec: "av1" });
  assert.equal(chooseKeeper([metadataRich, highResolution], { keeperRules: ["metadata", "resolution"] }).id, 1);
  assert.equal(chooseKeeper([metadataRich, highResolution], { keeperRules: ["resolution", "metadata"] }).id, 2);
});

test("codec preference follows configured order", () => {
  const h264 = video(1, { codec: "h264" });
  const hevc = video(2, { codec: "h265" });
  assert.equal(chooseKeeper([h264, hevc], { keeperRules: ["codec"], preferredCodecs: ["hevc", "h264"] }).id, 2);
});

test("default keeper order prefers resolution, codec, bitrate, then duration", () => {
  const shortRich = video(1, { duration: 60, details: "metadata" });
  const longSparse = video(2, { duration: 90 });
  assert.equal(chooseKeeper([shortRich, longSparse], {}).id, 2);
  assert.equal(chooseKeeper([video(3, { width: 3840, duration: 30 }), longSparse], {}).id, 3);
  assert.equal(chooseKeeper([video(4, { codec: "hevc", duration: 30 }), longSparse], {}).id, 4);
  assert.equal(chooseKeeper([video(5, { bitRate: 9000, duration: 30 }), longSparse], {}).id, 5);
});

test("metadata merge fills scalar gaps and unions relationships", () => {
  const update = buildMergedVideoUpdate(
    { title: "   ", details: null, tags: [{ id: 1 }], performers: [], urls: ["keeper"], groups: [{ id: 4, videoIndex: 2 }], customFields: { kept: "yes" } },
    [{
      title: "Deleted title", code: "CODE", details: "Old details", director: "Director", date: "2026-01-02",
      rating: 80, studioId: 9, captions: "Caption", organized: false, isVr: true,
      tags: [{ id: 2 }], performers: [{ id: 7 }], galleries: [{ id: 8 }], urls: ["source"],
      groups: [{ id: 5, videoIndex: 1 }], remoteIds: [{ endpoint: "stash", remoteId: "abc" }],
      customFields: { note: "value" },
    }],
  );
  assert.equal(update.title, "Deleted title");
  assert.equal(update.code, "CODE");
  assert.equal(update.details, "Old details");
  assert.equal(update.director, "Director");
  assert.equal(update.date, "2026-01-02");
  assert.equal(update.rating, 80);
  assert.equal(update.studioId, 9);
  assert.equal(update.captions, "Caption");
  assert.equal(update.organized, false);
  assert.equal(update.isVr, true);
  assert.deepEqual(update.tagIds, [1, 2]);
  assert.deepEqual(update.performerIds, [7]);
  assert.deepEqual(update.galleryIds, [8]);
  assert.deepEqual(update.urls, ["keeper", "source"]);
  assert.deepEqual(update.groups, [{ groupId: 4, videoIndex: 2 }, { groupId: 5, videoIndex: 1 }]);
  assert.deepEqual(update.remoteIds, [{ endpoint: "stash", remoteId: "abc" }]);
  assert.deepEqual(update.customFields, { note: "value", kept: "yes" });
});

test("metadata copy count only includes values missing from the keeper", () => {
  const keeper = { title: "Keeper", details: null, tags: [{ id: 1 }], urls: ["same"], customFields: { known: "yes" } };
  const source = { title: "Source", details: "New", tags: [{ id: 1 }, { id: 2 }], urls: ["same", "new"], customFields: { known: "other", added: "value" } };
  assert.equal(metadataCopyCount(keeper, source), 4);
  assert.equal(metadataCopyCount(keeper, { title: "Different title", tags: [{ id: 1 }] }), 0);
  assert.equal(metadataCopyCount({ imagePath: null }, { imagePath: "/api/videos/2/image" }), 1);
});

test("auto selection leaves exactly one recommended keeper per group", () => {
  const groups = [[video(1, { width: 640 }), video(2, { width: 1920 }), video(3, { width: 1280 })]];
  assert.deepEqual([...autoSelectForDeletion(groups, { keeperRules: ["resolution"] })].sort(), [1, 3]);
  assert.deepEqual(validateKeeperSafety(groups, new Set([1, 3])), []);
  assert.equal(validateKeeperSafety(groups, new Set([1, 2, 3])).length, 1);
});

test("selection summary de-duplicates videos repeated across groups", () => {
  const one = video(1, { size: 100 });
  const two = video(2, { size: 200 });
  const three = video(3, { size: 300 });
  assert.deepEqual(selectedSummary([[one, two], [two, three]], new Set([1, 2])), { videos: 2, files: 2, bytes: 300 });
});

test("metadata count includes populated fields and relationships", () => {
  const item = video(1, { details: "Details", studioName: "Studio", tags: [{ name: "Tag" }], performers: [{ name: "Person" }] });
  assert.ok(metadataCount(item) >= 5);
});
