import test from "node:test";
import assert from "node:assert/strict";
import {
  AuthenticationRequiredError, authenticatedFetch, copyVideoMetadata, deleteVideo, findDuplicates,
  loadTranscodeResolutions, mediaUrls, request,
} from "../src/api.js";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function jwt(exp) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}

test("authenticated requests attach Cove's bearer token", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = storage({ cove_access_token: "access-token" });
  globalThis.sessionStorage = storage();
  let authorization = null;
  globalThis.fetch = async (_path, options) => {
    authorization = options.headers.get("Authorization");
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    await request("/api/test");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  }
  assert.equal(authorization, "Bearer access-token");
});

test("expired authentication refreshes in place and stores the rotated token pair", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  const expired = jwt(Math.floor(Date.now() / 1000) - 60);
  const refreshed = jwt(Math.floor(Date.now() / 1000) + 900);
  globalThis.localStorage = storage({ cove_access_token: expired, cove_refresh_token: "refresh-one" });
  globalThis.sessionStorage = storage();
  const paths = [];
  globalThis.fetch = async (path, options) => {
    paths.push(path);
    if (path === "/api/auth/refresh") {
      assert.deepEqual(JSON.parse(options.body), { refreshToken: "refresh-one" });
      return { ok: true, status: 200, json: async () => ({ token: refreshed, refreshToken: "refresh-two" }) };
    }
    assert.equal(options.headers.get("Authorization"), `Bearer ${refreshed}`);
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    await request("/api/test");
    assert.equal(globalThis.localStorage.getItem("cove_access_token"), refreshed);
    assert.equal(globalThis.localStorage.getItem("cove_refresh_token"), "refresh-two");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  }
  assert.deepEqual(paths, ["/api/auth/refresh", "/api/test"]);
});

test("concurrent expired requests share one token refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  const expired = jwt(Math.floor(Date.now() / 1000) - 60);
  const refreshed = jwt(Math.floor(Date.now() / 1000) + 900);
  globalThis.localStorage = storage({ cove_access_token: expired, cove_refresh_token: "refresh-one" });
  globalThis.sessionStorage = storage();
  let refreshes = 0;
  globalThis.fetch = async (path) => {
    if (path === "/api/auth/refresh") {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, status: 200, json: async () => ({ token: refreshed, refreshToken: "refresh-two" }) };
    }
    return { ok: true, status: 200 };
  };
  try {
    await Promise.all([authenticatedFetch("/api/one"), authenticatedFetch("/api/two")]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  }
  assert.equal(refreshes, 1);
});

test("a 401 reuses a token Cove rotated before starting another refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = storage({ cove_access_token: "old-access", cove_refresh_token: "old-refresh" });
  globalThis.sessionStorage = storage();
  let calls = 0;
  globalThis.fetch = async (path, options) => {
    calls++;
    assert.notEqual(path, "/api/auth/refresh");
    if (calls === 1) {
      globalThis.localStorage.setItem("cove_access_token", "new-access");
      globalThis.localStorage.setItem("cove_refresh_token", "new-refresh");
      return { ok: false, status: 401 };
    }
    assert.equal(options.headers.get("Authorization"), "Bearer new-access");
    return { ok: true, status: 200 };
  };
  try {
    await authenticatedFetch("/api/test");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  }
  assert.equal(calls, 2);
});

test("failed token refresh raises a typed authentication error", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = storage({ cove_access_token: "expired-access", cove_refresh_token: "expired-refresh" });
  globalThis.sessionStorage = storage();
  globalThis.fetch = async (path) => path === "/api/auth/refresh" ? { ok: false, status: 401 } : { ok: false, status: 401 };
  try {
    await assert.rejects(() => authenticatedFetch("/api/test"), AuthenticationRequiredError);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  }
});

test("a 401 refreshes and retries the interrupted request exactly once", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = storage({ cove_access_token: "old-access", cove_refresh_token: "refresh-one" });
  globalThis.sessionStorage = storage();
  let apiCalls = 0;
  let refreshes = 0;
  globalThis.fetch = async (path, options) => {
    if (path === "/api/auth/refresh") {
      refreshes++;
      return { ok: true, status: 200, json: async () => ({ token: "new-access", refreshToken: "refresh-two" }) };
    }
    apiCalls++;
    if (apiCalls === 1) return { ok: false, status: 401 };
    assert.equal(options.headers.get("Authorization"), "Bearer new-access");
    return { ok: true, status: 200 };
  };
  try {
    await authenticatedFetch("/api/test");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  }
  assert.equal(refreshes, 1);
  assert.equal(apiCalls, 2);
});

test("authenticated FormData uploads do not force a JSON content type", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = storage({ cove_access_token: "access-token" });
  globalThis.sessionStorage = storage();
  let headers;
  globalThis.fetch = async (_path, options) => {
    headers = options.headers;
    return { ok: true, status: 200 };
  };
  try {
    await authenticatedFetch("/api/upload", { method: "POST", body: new FormData() });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  }
  assert.equal(headers.has("Content-Type"), false);
  assert.equal(headers.get("Authorization"), "Bearer access-token");
});

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

test("permanent deletion passes the source-file choice directly to Cove", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (path, options = {}) => {
    assert.equal(path, "/api/videos/destroy");
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ deleted: 1 }), statusText: "OK" };
  };
  try {
    await deleteVideo(42, { deleteFiles: true, deleteGenerated: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requestBody, { ids: [42], deleteFiles: true, deleteGenerated: true });
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
    if (path === "/api/videos/2/image") return { ok: false, status: 404 };
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

test("metadata copy transfers a generated cover when the deleted video has no explicit imagePath", async () => {
  const writes = [];
  const responses = new Map([
    ["/api/videos/1", { id: 1, title: "Keeper", imagePath: null }],
    ["/api/videos/2", { id: 2, title: "Deleted", imagePath: null }],
    ["/api/videos/1/segments", []],
    ["/api/videos/2/segments", []],
    ["/api/videos/1/ratings", { hostId: 1, ratings: {} }],
    ["/api/videos/2/ratings", { hostId: 2, ratings: {} }],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/videos/2/image") {
      return { ok: true, status: 200, blob: async () => new Blob(["generated-cover"], { type: "image/jpeg" }) };
    }
    if (path === "/api/videos/1/image" && options.method === "POST") {
      writes.push({ path, method: options.method, body: options.body });
      return { ok: true, status: 200, text: async () => "{}" };
    }
    if (options.method) writes.push({ path, method: options.method, body: typeof options.body === "string" ? JSON.parse(options.body) : options.body || null });
    const body = responses.get(path) ?? {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body), statusText: "OK" };
  };

  try {
    await copyVideoMetadata(1, [2]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const coverUpload = writes.find((item) => item.path === "/api/videos/1/image");
  assert.ok(coverUpload.body instanceof FormData);
  assert.equal(coverUpload.body.get("file").size, 15);
});

test("metadata copy skips unavailable generated covers and tries the next deleted video", async () => {
  const writes = [];
  const videos = new Map([
    [1, { id: 1, title: "Keeper", imagePath: null }],
    [2, { id: 2, title: "First source", imagePath: null, details: "More metadata" }],
    [3, { id: 3, title: "Second source", imagePath: null }],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/videos/2/image") return { ok: false, status: 404 };
    if (path === "/api/videos/3/image") return { ok: true, status: 200, blob: async () => new Blob(["fallback-cover"], { type: "image/jpeg" }) };
    if (path === "/api/videos/1/image" && options.method === "POST") {
      writes.push({ path, method: options.method, body: options.body });
      return { ok: true, status: 200, text: async () => "{}" };
    }
    if (options.method) writes.push({ path, method: options.method, body: typeof options.body === "string" ? JSON.parse(options.body) : options.body || null });
    const videoMatch = String(path).match(/^\/api\/videos\/(\d+)$/);
    const body = videoMatch ? videos.get(Number(videoMatch[1])) : path.endsWith("/ratings") ? { ratings: {} } : [];
    return { ok: true, status: 200, text: async () => JSON.stringify(body), statusText: "OK" };
  };

  try {
    await copyVideoMetadata(1, [2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(writes.find((item) => item.path === "/api/videos/1/image").body.get("file").size, 14);
});

test("metadata copy reports a cover warning without aborting other metadata", async () => {
  const writes = [];
  const responses = new Map([
    ["/api/videos/1", { id: 1, title: "Keeper", imagePath: null }],
    ["/api/videos/2", { id: 2, title: "Deleted", imagePath: "/api/videos/2/image", details: "Copied details" }],
    ["/api/videos/1/segments", []],
    ["/api/videos/2/segments", [{ startSec: 4, endSec: 5, kind: "chapter", title: "Copied marker" }]],
    ["/api/videos/1/ratings", { ratings: {} }],
    ["/api/videos/2/ratings", { ratings: { quality: 90 } }],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/videos/2/image") throw new TypeError("network failure");
    if (options.method) writes.push({ path, method: options.method, body: typeof options.body === "string" ? JSON.parse(options.body) : options.body || null });
    const body = responses.get(path) ?? {};
    return { ok: true, text: async () => JSON.stringify(body), statusText: "OK" };
  };

  let result;
  try {
    result = await copyVideoMetadata(1, [2]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(result.warnings, ["Cover artwork could not be copied to video 1."]);
  assert.equal(writes.find((item) => item.path === "/api/videos/1" && item.method === "PUT").body.details, "Copied details");
  assert.equal(writes.find((item) => item.path.endsWith("/rating")).body.value, 90);
  assert.equal(writes.find((item) => item.path.endsWith("/segments") && item.method === "POST").body.title, "Copied marker");
});

test("metadata overwrite replaces conflicting fields, ratings, and cover", async () => {
  const writes = [];
  const responses = new Map([
    ["/api/videos/1", { id: 1, title: "Keeper", imagePath: "/api/videos/1/image", customFields: { note: "keeper" } }],
    ["/api/videos/2", { id: 2, title: "Deleted", imagePath: "/api/videos/2/image", customFields: { note: "deleted" } }],
    ["/api/videos/1/segments", []],
    ["/api/videos/2/segments", []],
    ["/api/videos/1/ratings", { ratings: { overall: 80 } }],
    ["/api/videos/2/ratings", { ratings: { overall: 95 } }],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/videos/2/image") return { ok: true, blob: async () => new Blob(["replacement-cover"], { type: "image/jpeg" }) };
    if (options.method) writes.push({ path, method: options.method, body: typeof options.body === "string" ? JSON.parse(options.body) : options.body || null });
    if (path === "/api/videos/1/image" && options.method === "POST") return { ok: true, text: async () => "{}" };
    const body = responses.get(path) ?? {};
    return { ok: true, text: async () => JSON.stringify(body), statusText: "OK" };
  };

  try {
    await copyVideoMetadata(1, [2], { overwriteConflicts: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const update = writes.find((item) => item.path === "/api/videos/1" && item.method === "PUT");
  assert.equal(update.body.title, "Deleted");
  assert.equal(update.body.customFields.note, "deleted");
  assert.equal(writes.find((item) => item.path.endsWith("/rating")).body.value, 95);
  assert.ok(writes.find((item) => item.path === "/api/videos/1/image").body instanceof FormData);
});
