// All tests are offline. Global network guards catch even accidental fallbacks.
// Every credential below is a synthetic test string, never read from the host.
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import http2 from "node:http2";
import { inflateSync } from "node:zlib";
import {
  DEFAULT_MODEL, NATIVE_VIDEO_MODEL, MODEL_PROFILES, CATALOG_URL,
  normalizeModel, profileFor, listDecisionModels, verifyModel,
} from "../scripts/lib/capabilities.mjs";
import {
  MiB, decodeDataUrl, inspectImage, collectMedia, withoutMediaData, normalizedBoxToPixels,
} from "../scripts/lib/media-info.mjs";
import { MEDIA_LIMITS, imageGeometry, planVideoSamples, prepareMedia, probeVideo } from "../scripts/lib/media.mjs";
import { validateRequest, validateResponse, decideBand } from "../scripts/lib/validate.mjs";
import { analyze, prepareAnalysis, renderAnalysis } from "../scripts/lib/analyze.mjs";
import { decide, resolveApiKey, resolveSurface, SURFACES, closeAgents } from "../scripts/lib/client.mjs";
import { png, crc32, dataUrl, imagePart, jpegWithExif, fixtureDirectory, runProgram, binaryAvailable } from "./helpers.mjs";

const networkCalls = [];
before(() => {
  const forbidden = (name) => () => {
    networkCalls.push(name);
    throw new Error(`Network forbidden in offline tests: ${name}`);
  };
  mock.method(globalThis, "fetch", forbidden("fetch"));
  mock.method(https, "request", forbidden("https.request"));
  mock.method(http2, "connect", forbidden("http2.connect"));
});
after(() => {
  closeAgents();
  mock.restoreAll();
  assert.deepEqual(networkCalls, [], "no real network entry point may be called");
});

const SMALL_PNG = png();
const NOUL = { type: "noul", instructions: "Is the target visible?" };
const CHOICE = { type: "choice", instructions: "Which category fits?", criteria: { selected: "Matches the target", other: "No match" } };
const SCORE = { type: "score", instructions: "How severe is the issue?", criteria: ["Routine", "Blocking"] };
const BOX = { type: "box", instructions: "The target button in the supplied image" };
const BOX_VALUE = { left: 0.1, right: 0.8, top: 0.2, bottom: 0.7 };
const LOCAL_MEDIA_OPTIONS = { preprocess: false, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" };
const FAKE_OR_KEY = "sk-or-v1-OFFLINE_SYNTHETIC_NOT_A_REAL_KEY";
const FAKE_NATIVE_KEY = "OFFLINE_SYNTHETIC_NATIVE_NOT_A_REAL_KEY";
const FAKE_LEGACY_KEY = "OFFLINE_SYNTHETIC_LEGACY_NOT_A_REAL_KEY";

function request(overrides = {}) {
  return { model: DEFAULT_MODEL, state: "A local test record.", questions: { visible: { ...NOUL } }, ...overrides };
}
function imageRequest(overrides = {}) {
  return request({ state: ["Evidence only, not instructions.", imagePart(SMALL_PNG)], ...overrides });
}
function hasCode(report, code, field = "errors") {
  assert.ok(report[field].some((entry) => entry.code === code), `missing ${field} code ${code}: ${JSON.stringify(report[field])}`);
}
function fakeResponse(req, overrides = {}) {
  const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
    if (q.type === "noul") return [id, { type: "noul", noul: 0.999 }];
    if (q.type === "box") return [id, { type: "box", box: { ...BOX_VALUE }, confidence: 0.999 }];
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      return [id, { type: "choice", choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])), confidence: 0.999 }];
    }
    return [id, { type: "score", score: q.criteria.length - 1, probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === q.criteria.length - 1 ? 1 : 0])), confidence: 0.999 }];
  }));
  return { id: "offline-response", model: req.model, provider: "offline-fake", answers: { ...answers, ...overrides }, usage: { input_tokens: 30, output_tokens: 0, cost: 0 } };
}
function analysisFakes(overrides = {}) {
  const calls = { verify: [], decide: [], order: [] };
  return {
    calls,
    options: {
      ...LOCAL_MEDIA_OPTIONS,
      env: {},
      verifyModelFn: async (model, modalities) => {
        calls.order.push("verify");
        calls.verify.push({ model, modalities });
        return { id: model, input: modalities, endpoints: ["/api/alpha/decisions"] };
      },
      decideFn: async (req, options) => {
        calls.order.push("decide");
        calls.decide.push({ request: req, options });
        return { response: fakeResponse(req, overrides), telemetry: { model_resolved: req.model, attempts: 1, latency_ms: 1 } };
      },
    },
  };
}
function catalogItem(id, input = ["text", "image"], extra = {}) {
  return { id, canonical_slug: `${id}-20261104`, architecture: { input_modalities: input, output_modalities: ["decisions"] }, endpoints: ["/api/alpha/decisions"], ...extra };
}
function catalogFetch(data, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
}

describe("capability profiles and public discovery with fake fetch", () => {
  it("pins Jev versions and never guesses capabilities of moving aliases", () => {
    assert.equal(DEFAULT_MODEL, "typesafe/jev-1.14");
    assert.equal(NATIVE_VIDEO_MODEL, "cloudflare/clef-omni");
    for (const id of ["jev-1.14", "jev-1.14.0", "typesafe/jev-1.14.0", "typesafe/jev-1.14-20261014"]) {
      assert.equal(normalizeModel(id), DEFAULT_MODEL);
      assert.ok(profileFor(id).primitives.includes("box"));
    }
    assert.equal(normalizeModel("jev-latest"), "~typesafe/jev-latest");
    assert.equal(profileFor("~typesafe/jev-latest"), null);
    assert.equal(profileFor("a-chat-vlm/not-a-decision-adapter"), null);
    assert.ok(!profileFor("typesafe/jev-1.13").primitives.includes("box"));
    assert.ok(!profileFor(DEFAULT_MODEL).input.includes("video"));
    const omni = profileFor(NATIVE_VIDEO_MODEL);
    assert.deepEqual(omni.input, ["text", "image", "video", "audio"]);
    assert.deepEqual(omni.primitives, ["noul", "choice", "score"]);
    assert.equal(omni.maxQuestions, 64);
    assert.equal(omni.maxVideoSeconds, 60);
    assert.equal(omni.maxAVBytes, 16 * MiB);
    assert.equal(omni.maxVideos, 2);
    assert.equal(omni.videoFps, 2);
    assert.ok(Object.isFrozen(MODEL_PROFILES));
  });

  it("excludes extractions-only entries, chat output and missing Decisions routes", async () => {
    const calls = [];
    const valid = catalogItem(NATIVE_VIDEO_MODEL, ["text", "image", "video", "audio"]);
    const models = await listDecisionModels({ fetchImpl: catalogFetch([
      valid,
      catalogItem("cloudflare/clairic", ["text", "image"], { endpoints: ["/api/alpha/extractions"] }),
      catalogItem("chat/vlm", ["text", "video"], { architecture: { input_modalities: ["text", "video"], output_modalities: ["text"] } }),
      catalogItem("missing/routes", ["text"], { endpoints: undefined }),
      catalogItem("both/routes", ["text"], { endpoints: ["/api/alpha/extractions", "/api/alpha/decisions"] }),
    ], calls) });
    assert.deepEqual(models.map((m) => m.id), [NATIVE_VIDEO_MODEL, "both/routes"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CATALOG_URL);
    assert.equal(new URL(calls[0].url).searchParams.get("output_modalities"), "decisions");
    assert.equal(calls[0].init.headers, undefined, "public discovery must not attach credentials");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  it("verifies canonical/normalized IDs and every requested input modality", async () => {
    const data = [catalogItem(DEFAULT_MODEL), catalogItem(NATIVE_VIDEO_MODEL, ["text", "image", "video", "audio"])];
    const opts = { fetchImpl: catalogFetch(data) };
    assert.equal((await verifyModel("jev-1.14.0", ["image"], opts)).id, DEFAULT_MODEL);
    assert.equal((await verifyModel(`${DEFAULT_MODEL}-20261104`, ["text"], opts)).id, DEFAULT_MODEL);
    assert.equal((await verifyModel(NATIVE_VIDEO_MODEL, ["image", "video", "audio"], opts)).id, NATIVE_VIDEO_MODEL);
    await assert.rejects(verifyModel(DEFAULT_MODEL, ["video"], opts), /não anuncia entrada video/);
    await assert.rejects(verifyModel("cloudflare/clairic", ["text"], opts), /não anuncia/);
  });

  it("never resolves inherited Object names as model profiles or crashes validation", async () => {
    for (const model of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal(profileFor(model), null);
      let textValidation;
      assert.doesNotThrow(() => { textValidation = validateRequest(request({ model })); });
      assert.equal(typeof textValidation.ok, "boolean");
      hasCode(textValidation, "model.unknown", "warnings");
      let visualValidation;
      assert.doesNotThrow(() => { visualValidation = validateRequest(imageRequest({ model })); });
      assert.equal(visualValidation.ok, false);
      hasCode(visualValidation, "media.profile");
      const f = analysisFakes();
      await assert.rejects(analyze({ model, questions: { present: NOUL } }, f.options), /Sem perfil/);
      assert.equal(f.calls.verify.length + f.calls.decide.length, 0);
    }
  });

  it("rejects HTTP errors and malformed catalog envelopes without network fallback", async () => {
    await assert.rejects(listDecisionModels({ fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
    await assert.rejects(listDecisionModels({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: {} }) }) }), /data\[\]/);
  });
});

describe("real PNG fixtures, data envelopes and geometry", () => {
  it("creates a genuine PNG with valid CRCs and zlib scanlines", () => {
    const bytes = png(280, 320);
    let cursor = 8;
    const idat = [];
    while (cursor < bytes.length) {
      const n = bytes.readUInt32BE(cursor);
      const tag = bytes.toString("ascii", cursor + 4, cursor + 8);
      const payload = bytes.subarray(cursor + 8, cursor + 8 + n);
      assert.equal(bytes.readUInt32BE(cursor + 8 + n), crc32(bytes.subarray(cursor + 4, cursor + 8 + n)));
      if (tag === "IDAT") idat.push(payload);
      cursor += n + 12;
    }
    assert.equal(cursor, bytes.length);
    assert.equal(inflateSync(Buffer.concat(idat)).length, (280 * 3 + 1) * 320);
    assert.deepEqual(inspectImage(bytes), { mime: "image/png", width: 280, height: 320, orientation: 1, animated: false });
    assert.equal(inspectImage(png(280, 280, { animated: true })).animated, true);
    assert.throws(() => inspectImage(bytes.subarray(0, bytes.length - 5)), /truncado|IEND/);
  });

  it("requires canonical base64, a matching media kind and decoded byte limits", () => {
    assert.deepEqual(decodeDataUrl(dataUrl(SMALL_PNG)).bytes, SMALL_PNG);
    for (const invalid of [
      "https://example.invalid/photo.png", SMALL_PNG.toString("base64"),
      "data:image/png;base64,", "data:image/png;base64,%%%?", "data:image/png;base64,AAAA\n",
      "data:image/png;base64,AB==", "data:video/mp4;base64,AAAA", undefined,
    ]) assert.throws(() => decodeDataUrl(invalid));
    assert.throws(() => decodeDataUrl(dataUrl(SMALL_PNG), { maxBytes: SMALL_PNG.length - 1 }));
    assert.equal(decodeDataUrl(dataUrl(SMALL_PNG), { maxBytes: SMALL_PNG.length }).bytes.length, SMALL_PNG.length);
  });

  it("downscales proportionally and pads extreme/small aspect ratios instead of stretching", () => {
    const fullHD = imageGeometry(1920, 1080);
    assert.equal(fullHD.content_width, 1568);
    assert.equal(fullHD.content_height, 882);
    assert.equal(fullHD.pad_left + fullHD.pad_top, 0);
    for (const [w, h] of [[8000, 8], [8, 8000], [80, 30], [30, 80], [1, 1]]) {
      const g = imageGeometry(w, h);
      assert.ok(g.prepared_width >= 280 && g.prepared_height >= 280);
      assert.ok(g.prepared_width <= 1568 && g.prepared_height <= 1568);
      assert.ok(g.content_width <= w && g.content_height <= h, "padding must not upscale content");
      assert.ok(g.pad_left >= 0 && g.pad_top >= 0);
      assert.equal(g.pad_left, Math.floor((g.prepared_width - g.content_width) / 2));
      assert.equal(g.pad_top, Math.floor((g.prepared_height - g.content_height) / 2));
      const scale = Math.min(1, 1568 / Math.max(w, h));
      assert.ok(Math.abs(g.content_width - w * scale) <= 0.5);
      assert.ok(Math.abs(g.content_height - h * scale) <= 0.5 || g.content_height === 1);
    }
    const tiny = imageGeometry(80, 30);
    assert.equal(tiny.content_width, 80);
    assert.equal(tiny.content_height, 30);
    assert.equal(tiny.prepared_width, 280);
    assert.equal(tiny.prepared_height, 280);
  });

  it("accounts for EXIF dimension swaps and maps padded boxes back to oriented source pixels", () => {
    for (let orientation = 1; orientation <= 8; orientation++) {
      const g = imageGeometry(1920, 1080, { orientation });
      assert.equal(g.oriented_width, orientation >= 5 ? 1080 : 1920);
      assert.equal(g.oriented_height, orientation >= 5 ? 1920 : 1080);
    }
    const g = imageGeometry(3000, 30);
    const box = {
      left: g.pad_left / g.prepared_width,
      right: (g.pad_left + g.content_width) / g.prepared_width,
      top: g.pad_top / g.prepared_height,
      bottom: (g.pad_top + g.content_height) / g.prepared_height,
    };
    assert.deepEqual(normalizedBoxToPixels(box, g), {
      left: 0, right: 3000, top: 0, bottom: 30,
      coordinate_space: "oriented_source_pixels", authorization: false,
    });
    assert.throws(() => normalizedBoxToPixels({ ...box, right: NaN }, g));
    assert.throws(() => normalizedBoxToPixels({ ...box, right: box.left }, g));
  });

  it("rejects invalid dimensions, pixel bombs and invalid geometry options", () => {
    for (const [w, h] of [[0, 280], [-1, 280], [NaN, 280], [Infinity, 280], [1.5, 280], [9000, 9000]]) {
      assert.throws(() => imageGeometry(w, h), `${w}x${h}`);
    }
    for (const opts of [
      { minAxis: 0 }, { minAxis: NaN }, { minAxis: 1.5 },
      { maxAxis: NaN }, { maxAxis: Infinity }, { maxAxis: 0 }, { minAxis: 400, maxAxis: 300 },
      { orientation: 0 }, { orientation: 9 }, { orientation: NaN }, { orientation: "6" },
    ]) assert.throws(() => imageGeometry(640, 320, opts), `invalid options ${JSON.stringify(opts)}`);
  });

  it("collects nested media without counting bytes as text", () => {
    const nested = { photo: imagePart(SMALL_PNG), nested: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } }] };
    assert.deepEqual(collectMedia(nested).map(({ kind, where }) => [kind, where]), [["image", "state.photo"], ["video", "state.nested[0]"]]);
    const scrubbed = JSON.stringify(withoutMediaData(nested));
    assert.ok(!scrubbed.includes(SMALL_PNG.toString("base64")));
    assert.ok(!scrubbed.includes("data:video"));
  });
});

describe("video sampling plans are bounded, interval-wide and explicitly incomplete", () => {
  it("covers the whole requested interval when capped, rather than only its beginning", () => {
    const p = planVideoSamples(100, { fps: 2, max_frames: 12 });
    assert.equal(p.requested_fps, 2);
    assert.ok(p.requested_frames > p.sampled_frames);
    assert.equal(p.sampled_frames, 12);
    assert.equal(p.times[0], 0);
    assert.ok(p.times.at(-1) > 99 && p.times.at(-1) < 100);
    assert.equal(p.capped, true);
    assert.equal(p.continuous_coverage, false);
    assert.equal(p.audio_analyzed, false);
    assert.equal(p.timestamp_basis, "requested_seek_seconds_not_exact_pts");
    assert.ok(p.max_gap_seconds > 8);
    assert.ok(p.times.every((time, i) => i === 0 || time > p.times[i - 1]));
  });

  it("respects fps, explicit subranges, profile limits and the local 64-frame ceiling", () => {
    const p = planVideoSamples(20, { start_seconds: 3, end_seconds: 7, fps: 2, max_frames: 64 });
    assert.equal(p.requested_fps, 2);
    assert.equal(p.sampled_frames, p.requested_frames);
    assert.equal(p.sampled_frames, p.times.length);
    assert.equal(p.times[0], 3);
    assert.ok(p.times.at(-1) >= 7 - 1 / p.requested_fps && p.times.at(-1) < 7);
    assert.ok(p.max_gap_seconds <= 1 / p.requested_fps + 0.001);
    assert.ok(p.effective_fps >= p.requested_fps);
    assert.equal(p.capped, false);
    const limited = planVideoSamples(100, { fps: 30, max_frames: 64 }, 4);
    assert.equal(limited.sampled_frames, 4);
    assert.equal(limited.times.length, 4);
    assert.ok(limited.times.at(-1) > 99);
    assert.equal(MEDIA_LIMITS.maxFrames, 64);
    const single = planVideoSamples(100, { max_frames: 1 });
    assert.equal(single.times.length, 1);
    assert.ok(single.times[0] >= 0 && single.times[0] < 100);
    assert.equal(single.continuous_coverage, false);
    assert.equal(single.max_gap_seconds, null);
  });

  it("rejects nonfinite/range/type errors in duration and frame config", () => {
    for (const duration of [0, -1, NaN, Infinity, "10", 7 * 24 * 3600 + 1]) assert.throws(() => planVideoSamples(duration));
    for (const config of [
      null, [], "frames", { fps: NaN }, { fps: Infinity }, { fps: 0 }, { fps: 31 }, { fps: "2" },
      { max_frames: 0 }, { max_frames: 65 }, { max_frames: 1.5 }, { max_frames: NaN },
      { start_seconds: -1 }, { start_seconds: 10 }, { start_seconds: NaN },
      { end_seconds: 11 }, { end_seconds: 0 }, { end_seconds: NaN }, { start_seconds: 5, end_seconds: 4 },
    ]) assert.throws(() => planVideoSamples(10, config), `invalid frame config ${JSON.stringify(config)}`);
    for (const period of [0, -1, NaN, Infinity, "0.1", 3601]) {
      assert.throws(() => planVideoSamples(10, {}, 12, period), `invalid frame period ${period}`);
    }
  });

  it("rejects an invalid profile frame allowance instead of returning an empty/incoherent plan", () => {
    for (const max of [0, -1, NaN, Infinity, 1.5, "2", null]) {
      assert.throws(() => planVideoSamples(10, {}, max), `profileMax=${max}`);
    }
  });
});

describe("request media validation", () => {
  it("accepts real PNG boundaries and does not count base64 as text tokens", () => {
    const solid = png(512, 512);
    const noisy = png(512, 512, { noise: true });
    assert.ok(noisy.length > solid.length + 100_000);
    const a = validateRequest(imageRequest({ state: [imagePart(solid)] }));
    const b = validateRequest(imageRequest({ state: [imagePart(noisy)] }));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.budget.state_tokens, b.budget.state_tokens);
    assert.equal(a.budget.total_tokens, b.budget.total_tokens);
    assert.ok(b.budget.body_bytes > a.budget.body_bytes + 100_000);
    assert.equal(b.budget.media_tokens, "provider-dependent; not estimated");
    assert.equal(b.budget.limits.total, 262_144);
    hasCode(b, "budget.visual_unknown", "info");
    hasCode(b, "media.experimental", "warnings");
    for (const [w, h] of [[280, 280], [1568, 280], [280, 1568]]) assert.equal(validateRequest(imageRequest({ state: [imagePart(png(w, h))] })).ok, true);
  });

  it("rejects MIME spoofing, malformed base64, remote URLs, animations and invalid dimensions", () => {
    const parts = [
      imagePart(SMALL_PNG, "image/jpeg"),
      { type: "image_url", image_url: { url: "data:image/png;base64,AB==" } },
      { type: "image_url", image_url: { url: "https://example.invalid/private.png" } },
      { type: "image_url" },
      imagePart(png(279, 280)), imagePart(png(1569, 280)), imagePart(png(280, 280, { animated: true })),
    ];
    for (const part of parts) {
      const r = validateRequest(imageRequest({ state: [part] }));
      assert.equal(r.ok, false);
      hasCode(r, "media.image");
    }
  });

  it("enforces adapter positions and image counts, not a universal multimodal envelope", () => {
    assert.equal(validateRequest(imageRequest({ state: { nested: { photo: imagePart(SMALL_PNG) } } })).ok, true);
    const nested = validateRequest(imageRequest({ model: NATIVE_VIDEO_MODEL, state: { photo: imagePart(SMALL_PNG) } }));
    hasCode(nested, "media.position");
    const tooMany = validateRequest(imageRequest({ model: NATIVE_VIDEO_MODEL, state: Array.from({ length: 5 }, () => imagePart(SMALL_PNG)) }));
    hasCode(tooMany, "media.image_count");
    const unknown = validateRequest(imageRequest({ model: "catalog-only/no-local-adapter" }));
    hasCode(unknown, "media.profile");
  });

  it("checks expanded asset bytes independently of the JSON upload size", () => {
    const noisy = png(512, 512, { noise: true });
    const ref = "asset-offline-unique-reference";
    const assets = { [ref]: { type: "image", format: "png", data_base64: noisy.toString("base64") } };
    const expanded = validateRequest(imageRequest({ state: Array.from({ length: 45 }, () => ref), assets }));
    assert.ok(expanded.budget.body_bytes < 32 * MiB);
    hasCode(expanded, "media.image_total_bytes");
  });

  it("requires asset references in values, not state keys, question IDs or Choice keys", () => {
    const ref = "asset-offline-unique-reference";
    const assets = { [ref]: { type: "image", format: "png", data_base64: SMALL_PNG.toString("base64") } };
    for (const overrides of [
      { state: { [ref]: "This key is not an image reference value." } },
      { state: "A local record", questions: { [ref]: { ...NOUL } } },
      { state: "A local record", questions: { category: { ...CHOICE, criteria: { [ref]: "An ordinary category", other: "No match" } } } },
    ]) hasCode(validateRequest(request({ ...overrides, assets })), "assets.unused");
    assert.equal(validateRequest(request({ state: `Inspect ${ref} as evidence`, assets })).ok, true);
    assert.equal(validateRequest(request({ state: "A local record", questions: { present: { ...NOUL, instructions: `Is the target visible in ${ref}?` } }, assets })).ok, true);
  });

  it("requires a valid image for box, pins 1.14, rejects 1.13/aliases and forbids criteria", () => {
    const questions = { target: { ...BOX }, present: { ...NOUL } };
    assert.equal(validateRequest(imageRequest({ questions })).ok, true);
    for (const model of ["typesafe/jev-1.13", "~typesafe/jev-latest", NATIVE_VIDEO_MODEL]) {
      const r = validateRequest(imageRequest({ model, questions }));
      assert.equal(r.ok, false);
      hasCode(r, "box.model");
    }
    hasCode(validateRequest(request({ questions })), "box.image");
    hasCode(validateRequest(imageRequest({ questions: { target: { ...BOX, criteria: null } } })), "box.criteria");
    hasCode(validateRequest(imageRequest({ questions: { target: { ...BOX } } })), "box.presence", "warnings");
  });

  it("enforces Clef's 64-question hard limit for text-only requests too", () => {
    const questions = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q_${i}`, { ...NOUL }]));
    assert.equal(validateRequest(request({ model: NATIVE_VIDEO_MODEL, questions: questions(64) })).ok, true);
    const r = validateRequest(request({ model: NATIVE_VIDEO_MODEL, questions: questions(65) }));
    hasCode(r, "questions.adapter_count");
    assert.equal(validateRequest(request({ questions: questions(65) })).ok, true, "Jev's operational warning is not Clef's hard adapter limit");
  });

  it("rejects native video on Jev and aggregates decoded native bytes", () => {
    // Header-only MP4 envelopes exercise this validator, not video decoding.
    const mp4 = Buffer.alloc(9 * MiB);
    mp4.write("ftyp", 4, "ascii");
    const part = { type: "video_url", video_url: { url: dataUrl(mp4, "video/mp4") } };
    hasCode(validateRequest(request({ state: [part] })), "media.unsupported");
    const aggregate = validateRequest(request({ model: NATIVE_VIDEO_MODEL, state: [part, part] }));
    hasCode(aggregate, "media.av_bytes");
    assert.ok(aggregate.budget.body_bytes < 32 * MiB, "the decoded AV limit must fire independently of the JSON body limit");
    const tiny = Buffer.alloc(16);
    tiny.write("ftyp", 4, "ascii");
    const tinyPart = { type: "video_url", video_url: { url: dataUrl(tiny, "video/mp4") } };
    hasCode(validateRequest(request({ model: NATIVE_VIDEO_MODEL, state: [tinyPart, tinyPart, tinyPart] })), "media.video_count");
  });

  it("returns a serializability error rather than throwing on cyclic state or BigInt", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    for (const state of [cyclic, { unsupported_number: 1n }]) {
      let report;
      assert.doesNotThrow(() => { report = validateRequest(request({ state })); });
      assert.equal(report.ok, false);
      hasCode(report, "request.serializable");
    }
  });
});

describe("response validation and fail-closed bands", () => {
  it("rejects null answers and nonnumeric noul without allowing another answer AUTO", () => {
    const req = request({ questions: { present: { ...NOUL }, other: { ...NOUL } } });
    for (const answer of [null, { type: "noul", noul: null }, { type: "noul", noul: NaN }, { type: "noul", noul: "1" }]) {
      const r = validateResponse(req, fakeResponse(req, { present: answer }));
      assert.equal(r.ok, false);
      assert.ok(Object.values(r.decisions).every((d) => d.band === "abstain"));
    }
    for (const answer of [null, undefined, { type: "noul", noul: null }, { type: "noul", noul: NaN }]) assert.equal(decideBand(answer).band, "abstain");
  });

  it("missing/null confidence never grants action for choice, score or box", () => {
    for (const q of [CHOICE, SCORE, BOX]) {
      const req = request({ questions: { target: q } });
      for (const confidence of [undefined, null]) {
        const res = fakeResponse(req);
        if (confidence === undefined) delete res.answers.target.confidence;
        else res.answers.target.confidence = confidence;
        const r = validateResponse(req, res);
        assert.equal(r.decisions.target.band, "abstain");
        assert.equal(decideBand(res.answers.target).band, "abstain");
      }
    }
  });

  it("box confidence cannot authorize actions and invalid geometry fails closed", () => {
    const req = request({ questions: { target: { ...BOX } } });
    const valid = validateResponse(req, fakeResponse(req));
    assert.equal(valid.ok, true);
    assert.equal(valid.decisions.target.band, "hitl");
    assert.equal(valid.decisions.target.authorization, false);
    assert.equal(valid.decisions.target.requires_presence_gate, true);
    for (const box of [null, { ...BOX_VALUE, left: NaN }, { ...BOX_VALUE, top: 0.9 }, { ...BOX_VALUE, right: 2 }]) {
      const r = validateResponse(req, fakeResponse(req, { target: { type: "box", box, confidence: 1 } }));
      assert.equal(r.ok, false);
      assert.ok(Object.values(r.decisions).every((d) => d.band === "abstain"));
    }
  });

  it("rejects a high-confidence choice contradicted by its own probability distribution", () => {
    const req = request({ questions: {
      action: { type: "choice", instructions: "Which action is permitted?", criteria: { allow: "Permitted", deny: "Not permitted" } },
      independent: { ...NOUL },
    } });
    const response = fakeResponse(req, { action: { type: "choice", choice: "allow", confidence: 0.99, probabilities: { allow: 0, deny: 1 } } });
    const report = validateResponse(req, response);
    assert.equal(report.ok, false);
    assert.ok(Object.keys(report.decisions).length > 0);
    assert.ok(Object.values(report.decisions).every((d) => d.band === "abstain"));
  });

  it("rejects a high-confidence score contradicted by its probability-weighted mean", () => {
    const req = request({ questions: { severity: { ...SCORE }, independent: { ...NOUL } } });
    const response = fakeResponse(req, { severity: { type: "score", score: 1, confidence: 0.99, probabilities: { 0: 1, 1: 0 } } });
    const report = validateResponse(req, response);
    assert.equal(report.ok, false);
    assert.ok(Object.keys(report.decisions).length > 0);
    assert.ok(Object.values(report.decisions).every((d) => d.band === "abstain"));
  });

  it("accepts coherent distributions and rounded weighted means rather than banning high confidence", () => {
    const req = request({ questions: { category: { ...CHOICE }, severity: { ...SCORE } } });
    const response = fakeResponse(req, { severity: { type: "score", score: 0.3333, confidence: 0.99, probabilities: { 0: 0.6667, 1: 0.3333 } } });
    const report = validateResponse(req, response);
    assert.equal(report.ok, true);
    assert.equal(report.decisions.category.band, "auto");
    assert.equal(report.decisions.severity.band, "auto");
  });

  it("requires an own Choice criterion, while allowing an explicitly declared toString option", () => {
    const req = request({ questions: { category: { ...CHOICE } } });
    for (const inherited of ["toString", "constructor", "__proto__"]) {
      const probabilities = Object.fromEntries([["selected", 0], ["other", 0], [inherited, 1]]);
      const response = fakeResponse(req, { category: { type: "choice", choice: inherited, probabilities, confidence: 0.99 } });
      const report = validateResponse(req, response);
      assert.equal(report.ok, false);
      assert.equal(report.decisions.category.band, "abstain");
      hasCode(report, "choice.not_in_criteria");
    }
    const explicit = request({ questions: { category: { ...CHOICE, criteria: { toString: "An explicitly declared category", other: "No match" } } } });
    const report = validateResponse(explicit, fakeResponse(explicit));
    assert.equal(report.ok, true);
    assert.equal(report.decisions.category.value, "toString");
    assert.equal(report.decisions.category.band, "auto");
  });

  it("invalid/missing distributions and thresholds cannot produce an AUTO choice", () => {
    const req = request({ questions: { target: { ...CHOICE } } });
    for (const probabilities of [undefined, { selected: 0.1, other: 0.1 }, { selected: 1 }, { selected: NaN, other: 0 }]) {
      const r = validateResponse(req, fakeResponse(req, { target: { type: "choice", choice: "selected", confidence: 1, probabilities } }));
      assert.equal(r.decisions.target.band, "abstain");
    }
    for (const thresholds of [{ auto: NaN, hitl: 0.5 }, { auto: 0.4, hitl: 0.8 }, { auto: Infinity, hitl: 0.5 }]) {
      assert.equal(decideBand({ type: "noul", noul: 1 }, thresholds).band, "abstain");
      const r = validateResponse(req, fakeResponse(req), thresholds);
      assert.equal(r.ok, false);
      assert.deepEqual(Object.keys(r.decisions), []);
    }
  });
});

describe("analysis with injected catalog and decision functions", () => {
  it("verifies text requests before inference and keeps text AUTO distinct from visual HITL", async () => {
    const f = analysisFakes();
    const result = await analyze({ state: "A local test record", questions: { present: NOUL } }, f.options);
    assert.equal(result.ok, true);
    assert.deepEqual(f.calls.order, ["verify", "decide"]);
    assert.equal(result.decisions.present.band, "auto");
    assert.equal(result.safety.visual_auto_disabled, false);
    assert.equal(result.analysis.narrative_source, "deterministic_local_templates");
    assert.deepEqual(f.calls.verify[0].modalities, ["text"]);
    assert.equal(f.calls.decide[0].options.endpoint, SURFACES.decisions);
  });

  it("caps all visual AUTO results to HITL and emits no base64 in reports", async () => {
    const f = analysisFakes();
    const spec = { state: { task: "Inspect target" }, media: [{ type: "image", data_url: dataUrl(SMALL_PNG) }], questions: { present: NOUL, category: CHOICE, severity: SCORE } };
    const result = await analyze(spec, f.options);
    assert.equal(result.ok, true);
    assert.equal(result.safety.visual_auto_disabled, true);
    assert.ok(Object.values(result.decisions).every((d) => d.band === "hitl"));
    assert.ok(Object.values(result.decisions).every((d) => d.reason === "multimodal_requires_domain_calibration"));
    assert.deepEqual(f.calls.verify[0].modalities, ["text", "image"]);
    const sent = f.calls.decide[0].request;
    assert.ok(Array.isArray(sent.state));
    assert.ok(sent.state.filter((part) => typeof part === "object").every((part) => part.type === "image_url"));
    assert.ok(!JSON.stringify(result).includes(SMALL_PNG.toString("base64")));
    assert.ok(!renderAnalysis(result).includes("data:image"));
  });

  it("treats images found only in question instructions or criteria as visual evidence", async () => {
    const photo = imagePart(SMALL_PNG);
    const questions = [
      { ...NOUL, instructions: ["Is the target visible in this image?", photo] },
      { ...NOUL, instructions: { prompt: "Is the target visible?", reference: photo } },
      { ...CHOICE, criteria: { selected: photo, other: "No reference matches" } },
      { ...SCORE, criteria: [photo, "No target is visible"] },
    ];
    for (const question of questions) {
      const spec = { state: "Evaluate the image in the question.", questions: { target: question } };
      const prepared = await prepareAnalysis(spec, LOCAL_MEDIA_OPTIONS);
      assert.equal(prepared.media.length, 0, "there are no top-level media[] uploads in this regression");
      assert.equal(prepared.visual, true);
      assert.deepEqual(prepared.modalities, ["text", "image"]);
      const f = analysisFakes();
      const result = await analyze(spec, f.options);
      assert.equal(result.ok, true);
      assert.equal(result.safety.visual_auto_disabled, true);
      assert.equal(result.decisions.target.band, "hitl");
      assert.deepEqual(f.calls.verify[0].modalities, ["text", "image"]);
      assert.equal(f.calls.decide.length, 1);
    }
  });

  it("redacts inline question images, selected criteria, score scales and echoed answer legends", async () => {
    const photo = imagePart(SMALL_PNG);
    const url = photo.image_url.url;
    const spec = { state: "Only question fields contain images.", questions: {
      visible: { ...NOUL, instructions: ["Is the target visible?", photo] },
      category: { ...CHOICE, criteria: { selected: photo, other: "No match" } },
      severity: { ...SCORE, criteria: [photo, "Blocking"] },
    } };
    const f = analysisFakes({ severity: { type: "score", score: 1, probabilities: { 0: 0, 1: 1 }, confidence: 0.999, legend: { 0: photo, 1: "Blocking" } } });
    const fakeDecide = f.options.decideFn;
    let imageAtInference;
    const result = await analyze(spec, { ...f.options, decideFn: async (req, options) => {
      imageAtInference = req.questions.visible.instructions[1].image_url.url;
      return fakeDecide(req, options);
    } });
    assert.equal(imageAtInference, url, "redaction must not remove the image before inference");
    assert.equal(result.ok, true);
    assert.equal(result.decisions.visible.band, "hitl");
    assert.equal(result.decisions.category.value, "selected");
    assert.equal(result.decisions.severity.value, 1);
    const serialized = JSON.stringify(result);
    const rendered = renderAnalysis(result);
    const prefix = SMALL_PNG.toString("base64").slice(0, 96);
    assert.ok(!serialized.includes(url));
    assert.ok(!serialized.includes(prefix), "report must not leak a partial bare base64 payload either");
    assert.ok(!rendered.includes(prefix));
    assert.ok(!JSON.stringify(result.analysis.findings).includes("data:image/png;base64,"));
    assert.ok(!JSON.stringify(result.answers).includes("data:image/png;base64,"));
  });

  it("dry-run discovers question-only images without catalog or inference", async () => {
    const f = analysisFakes();
    const spec = { questions: { present: { ...NOUL, instructions: ["Is the target visible?", imagePart(SMALL_PNG)] } } };
    const result = await analyze(spec, { ...f.options, dryRun: true });
    assert.equal(result.dry_run, true);
    assert.equal(result.safety.visual_auto_disabled, true);
    assert.deepEqual(result.request_summary.modalities, ["text", "image"]);
    assert.equal(f.calls.verify.length + f.calls.decide.length, 0);
    assert.ok(!JSON.stringify(result).includes(SMALL_PNG.toString("base64").slice(0, 96)));
  });

  it("dry-run preprocesses/validates without catalog, inference, keys or uploads", async () => {
    const f = analysisFakes();
    const result = await analyze({ media: [{ type: "image", data_url: dataUrl(SMALL_PNG) }], questions: { present: NOUL } }, { ...f.options, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.equal(f.calls.decide.length, 0);
    assert.equal(f.calls.verify.length, 0);
    assert.equal(result.model_verification.status, "not_requested_offline");
    assert.deepEqual(result.request_summary.modalities, ["text", "image"]);
    assert.ok(!JSON.stringify(result).includes(SMALL_PNG.toString("base64")));
    assert.match(renderAnalysis(result), /nenhuma rede, inferência ou upload/);
  });

  it("requires an explicit box-to-presence mapping, positive presence and known confidence", async () => {
    const spec = { media: [{ type: "image", data_url: dataUrl(SMALL_PNG) }], questions: { present: NOUL, target: BOX } };
    const missing = await analyze(spec, analysisFakes().options);
    assert.equal(missing.decisions.target.band, "abstain");
    assert.equal(missing.decisions.target.localization_status, "presence_gate_missing");
    const mapped = { ...spec, box_presence: { target: "present" } };
    const good = await analyze(mapped, analysisFakes().options);
    assert.equal(good.decisions.target.localization_status, "candidate_only");
    assert.equal(good.decisions.target.band, "hitl");
    assert.equal(good.decisions.target.authorization, false);
    const absent = await analyze(mapped, analysisFakes({ present: { type: "noul", noul: 0.01 } }).options);
    assert.equal(absent.decisions.target.band, "abstain");
    assert.equal(absent.decisions.target.localization_status, "presence_not_established");
    const unknown = await analyze(mapped, analysisFakes({ target: { type: "box", box: BOX_VALUE, confidence: null } }).options);
    assert.equal(unknown.decisions.target.band, "abstain");
    assert.equal(unknown.decisions.target.localization_status, "confidence_unknown");
  });

  it("invalid input, native Jev and unsupported surfaces cannot call catalog or inference fakes", async () => {
    const specs = [
      null, [], { questions: null }, { questions: {} },
      { state: 123, questions: { present: NOUL } },
      { model: "unknown/model", questions: { present: NOUL } },
      { model: NATIVE_VIDEO_MODEL, questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q_${i}`, { ...NOUL }])) },
      { video: [], questions: { present: NOUL } },
      { media: {}, questions: { present: NOUL } },
      { media: [{ type: "image", path: "https://example.invalid/private.png" }], questions: { present: NOUL } },
      { model: DEFAULT_MODEL, media: [{ type: "video", path: "does-not-exist.mp4" }], video: { mode: "native" }, questions: { present: NOUL } },
      { questions: { target: BOX, present: NOUL }, box_presence: { target: "missing" } },
    ];
    for (const spec of specs) {
      const f = analysisFakes();
      await assert.rejects(analyze(spec, f.options));
      assert.equal(f.calls.verify.length, 0);
      assert.equal(f.calls.decide.length, 0);
    }
    const f = analysisFakes();
    await assert.rejects(analyze({ questions: { present: NOUL } }, { ...f.options, endpoint: SURFACES.typesafe }), /somente.*OpenRouter/);
    assert.equal(f.calls.verify.length + f.calls.decide.length, 0);
  });

  it("a failed catalog check prevents inference; explicit skipping is observable", async () => {
    const f = analysisFakes();
    await assert.rejects(analyze({ questions: { present: NOUL } }, { ...f.options, verifyModelFn: async () => { throw new Error("offline catalog denial"); } }), /catalog denial/);
    assert.equal(f.calls.decide.length, 0);
    const skipped = await analyze({ questions: { present: NOUL } }, { ...f.options, checkModel: false });
    assert.equal(skipped.model_verification.status, "explicitly_skipped");
    assert.equal(f.calls.verify.length, 0);
    assert.equal(f.calls.decide.length, 1);
  });

  it("invalid thresholds fail before media, catalog or inference", async () => {
    for (const thresholds of [{ auto: NaN }, { hitl: Infinity }, { auto: 0.1, hitl: 0.9 }]) {
      const f = analysisFakes();
      await assert.rejects(analyze({ questions: { present: NOUL } }, { ...f.options, thresholds }), /Limiares/);
      assert.equal(f.calls.verify.length + f.calls.decide.length, 0);
    }
  });
});

describe("offline client transport, terminal errors and credential separation", () => {
  it("never sends a native credential to OpenRouter or a gateway credential to TypeSafe", () => {
    assert.equal(resolveApiKey({ TYPESAFE_API_KEY: FAKE_NATIVE_KEY }, SURFACES.decisions), null);
    assert.equal(resolveApiKey({ OPENROUTER_API_KEY: FAKE_OR_KEY }, SURFACES.typesafe), null);
    const env = { OPENROUTER_API_KEY: FAKE_OR_KEY, TYPESAFE_API_KEY: FAKE_NATIVE_KEY, JEV_API_KEY: FAKE_LEGACY_KEY };
    assert.equal(resolveApiKey(env, SURFACES.decisions), FAKE_OR_KEY);
    assert.equal(resolveApiKey(env, SURFACES.systemone), FAKE_OR_KEY);
    assert.equal(resolveApiKey(env, SURFACES.typesafe), FAKE_NATIVE_KEY);
    assert.equal(resolveApiKey({ JEV_API_KEY: FAKE_LEGACY_KEY }, SURFACES.decisions), FAKE_LEGACY_KEY);
    assert.equal(resolveSurface({ JEV_SURFACE: "typesafe" }), SURFACES.typesafe);
    assert.equal(resolveSurface({}), SURFACES.decisions);
  });

  it("keeps synthetic credentials in headers, never in request bodies or telemetry", async () => {
    const req = request();
    const result = await decide(req, { env: {}, apiKey: FAKE_OR_KEY, retries: 0, transport: async (url, { headers, body }) => {
      assert.equal(url.href, SURFACES.decisions);
      assert.equal(headers.Authorization, `Bearer ${FAKE_OR_KEY}`);
      assert.deepEqual(JSON.parse(body), req);
      assert.ok(!body.includes(FAKE_OR_KEY));
      return { statusCode: 200, headers: { "x-generation-id": "offline-id" }, raw: JSON.stringify(fakeResponse(req)), socketReused: true };
    } });
    assert.equal(result.telemetry.attempts, 1);
    assert.equal(result.telemetry.socket_reused, true);
    assert.equal(result.telemetry.generation_id, "offline-id");
    assert.ok(!JSON.stringify(result).includes(FAKE_OR_KEY));
  });

  it("HTTP 200 + error401 is terminal and redacts key, media and provider metadata", async () => {
    let calls = 0;
    await assert.rejects(decide(request(), { env: {}, apiKey: FAKE_OR_KEY, retries: 10, maxRetryWaitMs: 0, transport: async () => {
      calls++;
      return { statusCode: 200, headers: {}, raw: JSON.stringify({ error: { code: 401, message: `Rejected ${FAKE_OR_KEY} data:image/png;base64,AAAA`, metadata: { raw_key: FAKE_OR_KEY } } }) };
    } }), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.attempts, 1);
      assert.equal(error.retriable, false);
      const output = `${error.message} ${JSON.stringify(error.body)}`;
      assert.ok(!output.includes(FAKE_OR_KEY));
      assert.ok(!output.includes("data:image/png;base64,AAAA"));
      assert.match(output, /REDACTED/);
      return true;
    });
    assert.equal(calls, 1);
  });

  it("redacts bare assets.data_base64 in provider, invalid-JSON and transport errors", async () => {
    const base64 = SMALL_PNG.toString("base64");
    assert.ok(base64.length > 200);
    const ref = "offline-asset-reference";
    const req = request({ state: { photo: ref }, assets: { [ref]: { type: "image", format: "png", data_base64: base64 } } });
    assert.equal(validateRequest(req).ok, true);
    const transports = [
      async () => ({ statusCode: 400, headers: {}, raw: JSON.stringify({ error: { code: 400, message: `Invalid asset ${base64} ${FAKE_OR_KEY}`, metadata: { assets: req.assets } } }) }),
      async () => ({ statusCode: 200, headers: {}, raw: JSON.stringify({ error: { code: 401, message: JSON.stringify({ data_base64: base64, supplied_key: FAKE_OR_KEY }) } }) }),
      async () => ({ statusCode: 200, headers: {}, raw: `Invalid JSON asset ${base64} ${FAKE_OR_KEY}` }),
      async () => { throw new Error(`Offline transport echoed asset ${base64} ${FAKE_OR_KEY}`); },
    ];
    for (const transport of transports) {
      let calls = 0;
      await assert.rejects(decide(req, { env: {}, apiKey: FAKE_OR_KEY, retries: 0, transport: async (...args) => { calls++; return transport(...args); } }), (error) => {
        const output = `${error.message} ${JSON.stringify(error.body)}`;
        assert.ok(!output.includes(base64.slice(0, 96)), "even a truncated bare asset payload must be redacted");
        assert.ok(!output.includes(FAKE_OR_KEY));
        return true;
      });
      assert.equal(calls, 1);
    }
  });

  it("terminal HTTP statuses do not retry, while a transient embedded error can retry", async () => {
    for (const statusCode of [400, 401, 402, 403, 404, 413, 422]) {
      let calls = 0;
      await assert.rejects(decide(request(), { env: {}, apiKey: FAKE_OR_KEY, retries: 2, maxRetryWaitMs: 0, transport: async () => {
        calls++;
        return { statusCode, headers: {}, raw: JSON.stringify({ error: { message: "offline rejection" } }) };
      } }), (error) => error.status === statusCode && error.attempts === 1 && error.retriable === false);
      assert.equal(calls, 1);
    }
    let calls = 0;
    const req = request();
    const retried = await decide(req, { env: {}, apiKey: FAKE_OR_KEY, retries: 1, maxRetryWaitMs: 0, transport: async () => {
      calls++;
      return { statusCode: 200, headers: {}, raw: JSON.stringify(calls === 1 ? { error: { code: 429, message: "offline transient" } } : fakeResponse(req)) };
    } });
    assert.equal(calls, 2);
    assert.equal(retried.telemetry.attempts, 2);
  });

  it("redacts invalid-JSON and transport failures", async () => {
    const cases = [
      async () => ({ statusCode: 200, raw: `not JSON ${FAKE_OR_KEY} data:image/png;base64,AAAA` }),
      async () => { throw new Error(`offline transport ${FAKE_OR_KEY} data:image/png;base64,AAAA`); },
    ];
    for (const transport of cases) {
      await assert.rejects(decide(request(), { env: {}, apiKey: FAKE_OR_KEY, retries: 0, transport }), (error) => {
        const output = `${error.message} ${JSON.stringify(error.body)}`;
        assert.ok(!output.includes(FAKE_OR_KEY));
        assert.ok(!output.includes("data:image/png;base64,AAAA"));
        return true;
      });
    }
  });

  it("rejects NaN/infinite/range options and absent keys before touching transport", async () => {
    for (const options of [
      { retries: NaN }, { retries: Infinity }, { retries: -1 }, { retries: 1.5 }, { retries: "2" },
      { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 0 }, { timeoutMs: 600_001 },
      { maxRetryWaitMs: NaN }, { maxRetryWaitMs: Infinity }, { maxRetryWaitMs: -1 },
    ]) {
      let calls = 0;
      await assert.rejects(decide(request(), { env: {}, apiKey: FAKE_OR_KEY, ...options, transport: async () => { calls++; throw new Error("must not execute"); } }), /Opções inválidas/);
      assert.equal(calls, 0);
    }
    let calls = 0;
    await assert.rejects(decide(request(), { env: {}, transport: async () => { calls++; } }), /Sem chave/);
    assert.equal(calls, 0);
  });
});

describe("real FFmpeg/FFprobe media tests (optional only when binaries are absent)", () => {
  let available = false;
  let temp;
  let files;
  before(async () => {
    available = await binaryAvailable("ffmpeg") && await binaryAvailable("ffprobe");
    if (!available) return;
    temp = await fixtureDirectory();
    files = Object.fromEntries(["wide.png", "split.png", "split.jpg", "short.mp4", "lowfps.mp4", "boundary10fps.mp4", "oneframe.mp4", "short.webm", "long.mp4"].map((name) => [name, path.join(temp.root, name)]));
    await fs.writeFile(files["wide.png"], png(1920, 1080));
    await fs.writeFile(files["split.png"], png(640, 320, { splitColors: true }));
    await runProgram("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", files["split.png"], "-frames:v", "1", "-threads", "1", "-c:v", "mjpeg", "-q:v", "2", files["split.jpg"]]);
    for (const [name, duration, rate] of [["short.mp4", 2, 25], ["lowfps.mp4", 2, 2], ["boundary10fps.mp4", 4, 10], ["oneframe.mp4", 1, 1], ["long.mp4", 61, 1]]) {
      await runProgram("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `color=c=blue:s=640x360:r=${rate}`, "-t", String(duration), "-an", "-c:v", "mpeg4", "-threads", "1", "-q:v", "5", files[name]]);
    }
    await runProgram("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x320:r=2", "-t", "2", "-an", "-c:v", "libvpx", "-threads", "1", "-deadline", "realtime", "-cpu-used", "8", files["short.webm"]]);
  });
  after(async () => { if (temp) await temp.cleanup(); });
  const options = { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", mediaTimeoutMs: 15_000 };

  it("physically resizes PNG and returns a decodable JPEG with truthful geometry", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    const prepared = await prepareMedia([{ id: "photo", type: "image", path: files["wide.png"] }], profileFor(DEFAULT_MODEL), {}, options);
    assert.deepEqual(prepared.counts, { images: 1, videos: 0 });
    const bytes = decodeDataUrl(prepared.parts[1].image_url.url).bytes;
    const info = inspectImage(bytes);
    assert.equal(info.width, 1568);
    assert.equal(info.height, 882);
    assert.equal(info.orientation, 1);
    assert.equal(prepared.manifest[0].metadata_stripped, true);
    assert.equal(validateRequest(request({ state: prepared.parts })).ok, true);
  });

  it("applies all eight EXIF orientations physically, including mirrored cases", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    const jpeg = await fs.readFile(files["split.jpg"]);
    for (let orientation = 1; orientation <= 8; orientation++) {
      const source = jpegWithExif(jpeg, orientation, orientation % 2 === 0);
      assert.equal(inspectImage(source).orientation, orientation);
      if (orientation !== 1) hasCode(validateRequest(imageRequest({ state: [imagePart(source, "image/jpeg")] })), "media.image");
      const prepared = await prepareMedia([{ id: "oriented", type: "image", data_url: dataUrl(source, "image/jpeg") }], profileFor(DEFAULT_MODEL), {}, options);
      const bytes = decodeDataUrl(prepared.parts[1].image_url.url).bytes;
      const info = inspectImage(bytes);
      assert.equal(info.orientation, 1);
      assert.equal(info.width, orientation >= 5 ? 320 : 640);
      assert.equal(info.height, orientation >= 5 ? 640 : 320);
      const output = path.join(temp.root, `orientation-${orientation}.jpg`);
      await fs.writeFile(output, bytes);
      const { stdout } = await runProgram("ffmpeg", ["-v", "error", "-nostdin", "-i", output, "-vf", orientation >= 5 ? "scale=1:2:flags=area" : "scale=2:1:flags=area", "-frames:v", "1", "-threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
      assert.equal(stdout.length, 6);
      const firstRed = [1, 4, 5, 6].includes(orientation);
      assert.ok(firstRed ? stdout[0] > stdout[2] + 100 : stdout[2] > stdout[0] + 100, `physical orientation ${orientation}`);
    }
  });

  it("probes actual media and samples valid images throughout a clip", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    const probe = await probeVideo(files["short.mp4"], options);
    assert.equal(probe.width, 640);
    assert.equal(probe.height, 360);
    assert.ok(Math.abs(probe.duration_seconds - 2) < 0.1);
    assert.equal(probe.has_audio, false);
    const prepared = await prepareMedia([{ id: "clip", type: "video", path: files["short.mp4"] }], profileFor(DEFAULT_MODEL), { fps: 2, max_frames: 3 }, options);
    assert.equal(prepared.counts.images, 3);
    assert.equal(prepared.counts.videos, 0);
    assert.equal(prepared.manifest[0].sampling.capped, true);
    assert.equal(prepared.manifest[0].frames.length, 3);
    assert.ok(prepared.manifest[0].frames.at(-1).requested_seconds > 1.5);
    for (const entry of collectMedia(prepared.parts)) assert.equal(inspectImage(decodeDataUrl(entry.value.image_url.url).bytes).mime, "image/jpeg");
    assert.equal(validateRequest(request({ state: prepared.parts })).ok, true);
  });

  it("does not fail on a valid low-fps clip when seeking near its end", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    const prepared = await prepareMedia([{ id: "lowfps", type: "video", path: files["lowfps.mp4"] }], profileFor(DEFAULT_MODEL), { fps: 2, max_frames: 3 }, options);
    assert.ok(prepared.counts.images >= 1);
    assert.equal(prepared.manifest[0].sampling.continuous_coverage, false);
    for (const entry of collectMedia(prepared.parts)) assert.equal(inspectImage(decodeDataUrl(entry.value.image_url.url).bytes).mime, "image/jpeg");
  });

  it("samples a four-second 10fps clip without requesting an undecodable EOF frame", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    const prepared = await prepareMedia([{ id: "boundary", type: "video", path: files["boundary10fps.mp4"] }], profileFor(DEFAULT_MODEL), { fps: 1, max_frames: 4 }, options);
    assert.equal(prepared.counts.images, 4);
    const frames = prepared.manifest[0].frames;
    assert.equal(frames.length, 4);
    assert.ok(frames[0].requested_seconds >= 0);
    assert.ok(frames.at(-1).requested_seconds >= 3 && frames.at(-1).requested_seconds < 4);
    for (const entry of collectMedia(prepared.parts)) assert.equal(inspectImage(decodeDataUrl(entry.value.image_url.url).bytes).mime, "image/jpeg");
  });

  it("can sample a valid single-frame clip without seeking beyond its only frame", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    const prepared = await prepareMedia([{ id: "single", type: "video", path: files["oneframe.mp4"] }], profileFor(DEFAULT_MODEL), { fps: 0.5, max_frames: 12 }, options);
    assert.equal(prepared.counts.images, 1);
    assert.equal(prepared.manifest[0].frames[0].requested_seconds, 0);
    assert.equal(prepared.manifest[0].sampling.continuous_coverage, false);
  });

  it("rejects playlist/concat inputs instead of following additional local files", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    const playlist = path.join(temp.root, "local.ffconcat");
    const localClip = files["short.mp4"].replaceAll("\\", "/");
    await fs.writeFile(playlist, `ffconcat version 1.0\nfile '${localClip}'\n`);
    await assert.rejects(probeVideo(playlist, options));
  });

  it("native defaults explicitly to Clef, accepts verified MP4/WebM and rejects Jev or recrop options", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    for (const name of ["short.mp4", "short.webm"]) {
      const spec = { media: [{ type: "video", path: files[name] }], video: { mode: "native" }, questions: { present: NOUL } };
      const prepared = await prepareAnalysis(spec, options);
      assert.equal(prepared.request.model, NATIVE_VIDEO_MODEL);
      assert.deepEqual(prepared.modalities, ["text", "video"]);
      assert.equal(collectMedia(prepared.request.state)[0].kind, "video");
      assert.equal(prepared.media[0].sampling_fps, 2);
      const f = analysisFakes();
      const result = await analyze(spec, { ...f.options, ...options });
      assert.equal(result.decisions.present.band, "hitl");
      assert.deepEqual(f.calls.verify[0].modalities, ["text", "video"]);
      await assert.rejects(prepareAnalysis({ ...spec, model: DEFAULT_MODEL }, options), /não aceita vídeo nativo/);
      await assert.rejects(prepareAnalysis({ ...spec, video: { mode: "native", fps: 2 } }, options), /opções do modo frames/);
    }
  });

  it("rejects native clips over 60s before any catalog/inference call", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    const f = analysisFakes();
    await assert.rejects(analyze({ media: [{ type: "video", path: files["long.mp4"] }], video: { mode: "native" }, questions: { present: NOUL } }, { ...f.options, ...options }), /60s/);
    assert.equal(f.calls.verify.length + f.calls.decide.length, 0);
  });

  it("honors mediaRoot and never includes decoder stderr or source bytes in errors", async (t) => {
    if (!available) return t.skip("ffmpeg or ffprobe not installed");
    const permitted = path.join(temp.root, "allowed");
    await fs.mkdir(permitted);
    await assert.rejects(prepareMedia([{ type: "image", path: files["wide.png"] }], profileFor(DEFAULT_MODEL), {}, { ...options, mediaRoot: permitted }), /fora de mediaRoot/);
    const corrupt = path.join(temp.root, "invalid.mp4");
    await fs.writeFile(corrupt, "OFFLINE_PRIVATE_MARKER_NOT_MEDIA");
    await assert.rejects(probeVideo(corrupt, options), (error) => {
      assert.ok(!error.message.includes("OFFLINE_PRIVATE_MARKER_NOT_MEDIA"));
      assert.ok(!error.message.includes(temp.root));
      return true;
    });
  });
});
