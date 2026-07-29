import test from "node:test";
import assert from "node:assert/strict";
import { copyVideoMetadata, findDuplicates, loadTranscodeResolutions, mediaUrls } from "../src/api.js";

test("comparison transcode URLs use Cove's FFmpeg endpoint and absolute start", () => {
  assert.equal(mediaUrls.transcode(42), "/api/stream/video/42/transcode");
  assert.equal(mediaUrls.transcode(42, 91.5), "/api/stream/video/42/transcode?start=91.5");
  assert.equal(mediaUrls.transcode(42, 91.5, "480p"), "/api/stream/video/42/transcode?resolution=480p&start=91.5");
});

test("media URLs include Cove access-token authentication", () => {
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = { getItem: (key) => key === "cove_access_token" ? "access token" : null };
  globalThis.sessionStorage = { getItem: () => null };
  try {
    assert.equal(mediaUrls.stream(42), "/api/stream/video/42?access_token=access+token");
    assert.equal(mediaUrls.transcode(42, 3, "480p"), "/api/stream/video/42/transcode?resolution=480p&start=3&access_token=access+token");
  } finally {
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  }
});

test("media URLs prefer Cove share credentials over an access token", () => {
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = { getItem: () => "ignored-access-token" };
  globalThis.sessionStorage = { getItem: (key) => ({ cove_share_token: "share/token", cove_share_password: "secret value" })[key] || null };
  try {
    assert.equal(mediaUrls.preview(42), "/api/stream/video/42/preview?share_token=share%2Ftoken&share_password=secret+value");
  } finally {
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  }
});

test("comparison loads Cove's configured transcode resolutions", async () => {
  let requestedPath = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    requestedPath = path;
    return { ok: true, text: async () => '["240p","480p"]', statusText: "OK" };
  };
  try {
    assert.deepEqual(await loadTranscodeResolutions(42), ["240p", "480p"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestedPath, "/api/stream/video/42/resolutions");
});

test("duplicate requests pass Cove's title and remote ID match types through", async () => {
  const paths = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    paths.push(path);
    return { ok: true, text: async () => "[]", statusText: "OK" };
  };
  try {
    await findDuplicates({ matchType: "title", phashDistance: 0 });
    await findDuplicates({ matchType: "remoteid", phashDistance: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(new URL(paths[0], "http://cove.test").searchParams.get("matchType"), "title");
  assert.equal(new URL(paths[1], "http://cove.test").searchParams.get("matchType"), "remoteid");
});

test("metadata copy updates the keeper before recreating ratings and markers", async () => {
  const writes = [];
  const responses = new Map([
    ["/api/videos/1", { id: 1, title: "Keeper", tags: [{ id: 1 }], groups: [{ id: 4, videoIndex: 2 }] }],
    ["/api/videos/2", { id: 2, title: "Deleted", details: "Details", tags: [{ id: 2 }] }],
    ["/api/videos/1/segments", [{ startSec: 1, endSec: 2, kind: "chapter", title: "Existing" }]],
    ["/api/videos/2/segments", [{ startSec: 3, endSec: 4, kind: "chapter", title: "Copied" }]],
    ["/api/videos/1/ratings", { hostId: 1, ratings: { overall: 80 } }],
    ["/api/videos/2/ratings", { hostId: 2, ratings: { overall: 20, quality: 90 } }],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options = {}) => {
    if (options.method) writes.push({ path, method: options.method, body: typeof options.body === "string" ? JSON.parse(options.body) : options.body || null });
    const body = responses.get(path) ?? {};
    return { ok: true, text: async () => JSON.stringify(body), statusText: "OK" };
  };

  try {
    await copyVideoMetadata(1, [2]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const update = writes.find((item) => item.method === "PUT");
  assert.equal(update.path, "/api/videos/1");
  assert.equal(update.body.details, "Details");
  assert.deepEqual(update.body.tagIds, [1, 2]);
  assert.deepEqual(update.body.groups, [{ groupId: 4, videoIndex: 2 }]);
  assert.deepEqual(writes.find((item) => item.path.endsWith("/rating")).body, { aspect: "quality", value: 90 });
  assert.equal(writes.find((item) => item.path.endsWith("/segments") && item.method === "POST").body.title, "Copied");
});

test("metadata copy fills a missing title and transfers the original explicit cover", async () => {
  const writes = [];
  const responses = new Map([
    ["/api/videos/1", { id: 1, title: "   ", imagePath: null }],
    ["/api/videos/2", { id: 2, title: "Source title", imagePath: "/api/videos/2/image?max=1280" }],
    ["/api/videos/1/segments", []],
    ["/api/videos/2/segments", []],
    ["/api/videos/1/ratings", { hostId: 1, ratings: {} }],
    ["/api/videos/2/ratings", { hostId: 2, ratings: {} }],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/videos/2/image") {
      return { ok: true, blob: async () => new Blob(["full-cover"], { type: "image/jpeg" }) };
    }
    if (path === "/api/videos/1/image" && options.method === "POST") {
      writes.push({ path, method: options.method, body: options.body });
      return { ok: true, text: async () => "{}" };
    }
    if (options.method) writes.push({ path, method: options.method, body: typeof options.body === "string" ? JSON.parse(options.body) : options.body || null });
    const body = responses.get(path) ?? {};
    return { ok: true, text: async () => JSON.stringify(body), statusText: "OK" };
  };

  try {
    await copyVideoMetadata(1, [2]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(writes.find((item) => item.method === "PUT").body.title, "Source title");
  const coverUpload = writes.find((item) => item.path === "/api/videos/1/image");
  assert.ok(coverUpload.body instanceof FormData);
  assert.equal(coverUpload.body.get("file").size, 10);
});
