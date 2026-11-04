// Public CLI/MCP and integration contracts, not duplicates of multimodal.test.mjs.
// OFFLINE: every Node subprocess has an allowlisted environment and a network
// preload; successful inference paths accept a synthetic key and fake replies only.
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import https from "node:https";
import http from "node:http";
import http2 from "node:http2";
import { integrate } from "../scripts/integrate.mjs";
import { createUploadAnalysisService, UploadAnalysisError } from "../examples/integration/upload-service.mjs";
import { fixtureDirectory, runProgram } from "./helpers.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRELOAD = pathToFileURL(path.join(ROOT, "tests", "mcp-preload.mjs")).href;
const CLI = path.join(ROOT, "scripts", "som.mjs");
const LEGACY_CLI = path.join(ROOT, "scripts", "jev.mjs");
const MEDIA = path.join(ROOT, "examples", "media");
const PHOTO = path.join(MEDIA, "photo.png");
const CLIP = path.join(MEDIA, "clip.mp4");
const requestFile = (name) => path.join(ROOT, "examples", "requests", name);
const FAKE_KEY = "sk-or-v1-SOM_OFFLINE_TEST_NOT_A_REAL_CREDENTIAL";
const DEFAULT_MODEL = "perplexity/pplx-decider-v1.2";
const LEGACY_MODEL = "typesafe/jev-1.13";
const NATIVE_MODEL = "cloudflare/clef-omni";
const NOUL = Object.freeze({ type: "noul", instructions: "Is the target visible?" });
const QUESTIONS = Object.freeze({ visible: NOUL });
const QUESTION_JSON = JSON.stringify(QUESTIONS);
const TEXT_ARGS = ["--state", "Synthetic offline record.", "--questions", QUESTION_JSON];
const AUDIT_PREFIX = "SOM_TEST_NETWORK_AUDIT ";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const mainNetworkCalls = [];
let ffmpegAvailable = false;
let ffprobeAvailable = false;

// Never spread or enumerate process.env: key variables, NODE_OPTIONS, proxy/base
// URLs, HOME and credential files are deliberately not inherited or inspected.
function cleanEnv(extra = {}) {
  const env = { SOM_TRANSPORT: "h1", FFMPEG_PATH: "ffmpeg", FFPROBE_PATH: "ffprobe" };
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

async function available(binary) {
  try {
    await runProgram(binary, ["-version"], { cwd: ROOT, env: cleanEnv() });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error; // A broken installed binary must not become a silent skip.
  }
}

before(async () => {
  const forbidden = (name) => () => {
    mainNetworkCalls.push(name);
    throw new Error(`Network forbidden in integration tests: ${name}`);
  };
  mock.method(globalThis, "fetch", forbidden("fetch"));
  mock.method(https, "request", forbidden("https.request"));
  mock.method(https, "get", forbidden("https.get"));
  mock.method(http, "request", forbidden("http.request"));
  mock.method(http, "get", forbidden("http.get"));
  mock.method(http2, "connect", forbidden("http2.connect"));
  ffmpegAvailable = await available("ffmpeg");
  ffprobeAvailable = await available("ffprobe");
});
after(() => {
  mock.restoreAll();
  assert.deepEqual(mainNetworkCalls, [], "exported integration/service paths must not attempt network access");
});

function executeNode(argv, { input = "", cwd = ROOT, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", PRELOAD, ...argv], {
      cwd, env: cleanEnv(env), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", bytes = 0, failure;
    const timer = setTimeout(() => {
      failure = new Error("Offline Node subprocess exceeded 20 seconds");
      child.kill();
    }, 20_000);
    const collect = (name) => (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (name === "stdout") stdout += chunk;
      else stderr += chunk;
      if (bytes > MAX_OUTPUT_BYTES && !failure) {
        failure = new Error("Offline Node subprocess exceeded the output limit");
        child.kill();
      }
    };
    child.stdout.setEncoding("utf8").on("data", collect("stdout"));
    child.stderr.setEncoding("utf8").on("data", collect("stderr"));
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") failure ??= error; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (signal || !Number.isInteger(code)) return reject(new Error(`Node subprocess interrupted: ${signal ?? code}`));
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function runNode(argv, { fake = false, response = "valid", env = {}, ...options } = {}) {
  const result = await executeNode(argv, {
    ...options,
    env: { ...env, SOM_TEST_NETWORK: fake ? "fake" : "deny", SOM_TEST_RESPONSE: response,
      ...(fake ? { OPENROUTER_API_KEY: FAKE_KEY } : {}) },
  });
  const lines = result.stderr.split(/\r?\n/).filter((line) => line.startsWith(AUDIT_PREFIX));
  assert.equal(lines.length, 1, `network preload must run exactly once: ${result.stderr}`);
  const audit = JSON.parse(lines[0].slice(AUDIT_PREFIX.length));
  assert.equal(audit.mode, fake ? "fake" : "deny");
  assert.deepEqual(audit.blocked, [], `no attempted network/fallback is allowed: ${result.stderr}`);
  if (!fake) {
    assert.equal(audit.catalog_calls, 0);
    assert.deepEqual(audit.decision_models, []);
  }
  assert.ok(!result.stdout.includes(FAKE_KEY) && !result.stderr.includes(FAKE_KEY), "credentials must not be printed");
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /data:[^\s"']+;base64,[A-Za-z0-9+/=]+/, "media payloads must not be printed");
  return { ...result, audit };
}
const cli = (args, options) => runNode([CLI, ...args], options);
function outputJson(result) {
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function assertDryRun(result, modalities) {
  const data = outputJson(result);
  assert.equal(data.ok, true);
  assert.equal(data.dry_run, true);
  assert.equal(data.model_verification.status, "not_requested_offline");
  assert.equal(data.safety.advisory_only, true);
  assert.equal(data.safety.executes_actions, false);
  assert.deepEqual(data.request_summary.modalities, modalities);
  assert.ok(!Object.hasOwn(data, "answers") && !Object.hasOwn(data, "decisions"), "preflight is not inference");
  return data;
}
async function tempFor(t) {
  // helpers.fixtureDirectory verifies the absolute target, expected parent and
  // mkdtemp prefix immediately before its recursive rm; no unchecked cleanup.
  const temporary = await fixtureDirectory();
  t.after(() => temporary.cleanup());
  return temporary.root;
}
function requireVideoTools(t, frames = true) {
  if (!ffprobeAvailable || (frames && !ffmpegAvailable)) {
    t.skip("FFprobe/FFmpeg absent; no downloads or network fallback");
    return false;
  }
  return true;
}

function rpc(id, method, params) {
  return { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) };
}
function call(id, name, args) { return rpc(id, "tools/call", { name, arguments: args }); }
async function mcp(messages, { args = [], ...options } = {}) {
  const result = await cli(["serve", "--retries", "0", "--media-root", MEDIA, ...args], {
    ...options, input: messages.map((message) => typeof message === "string" ? message : JSON.stringify(message)).join("\n") + "\n",
  });
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  assert.equal(byId.size, replies.length, "one response per request, with unique IDs");
  assert.ok(replies.every((reply) => reply.jsonrpc === "2.0"));
  return { ...result, replies, byId };
}
function toolPayload(reply, isError = false) {
  assert.ok(reply && !reply.error, JSON.stringify(reply));
  assert.equal(reply.result.isError, isError);
  assert.equal(reply.result.content.length, 1);
  assert.equal(reply.result.content[0].type, "text");
  return JSON.parse(reply.result.content[0].text);
}

describe("offline CLI entry points and dry-run contracts", () => {
  it("prints SOM help by default and through the legacy jev.mjs wrapper", async () => {
    const normal = await cli(["help"]);
    const implicit = await cli([]);
    const legacy = await runNode([LEGACY_CLI, "help"]);
    assert.equal(normal.code, 0);
    assert.equal(implicit.code, 0);
    assert.equal(legacy.code, 0);
    assert.equal(implicit.stdout, normal.stdout);
    assert.equal(legacy.stdout, normal.stdout);
    for (const text of ["som.mjs v", "analyze", "--dry-run", "evaluate_with_som", "analyze_media_with_som", "SOM_MODEL"]) {
      assert.ok(normal.stdout.includes(text), `missing help contract: ${text}`);
    }
  });

  it("ask --dry-run needs no key and the legacy wrapper also performs no inference", async () => {
    const args = ["ask", "--request-file", requestFile("ticket-triage.json"), "--dry-run", "--json"];
    const normal = assertDryRun(await cli(args), ["text"]);
    const legacy = assertDryRun(await runNode([LEGACY_CLI, ...args]), ["text"]);
    assert.equal(normal.model, LEGACY_MODEL);
    assert.deepEqual(legacy, normal);
    assert.equal(normal.safety.visual_auto_disabled, false);
  });

  it("ask without a key fails locally rather than attempting inference", async () => {
    const result = await cli(["ask", ...TEXT_ARGS, "--retries", "0", "--json"]);
    assert.notEqual(result.code, 0);
    const data = JSON.parse(result.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error.message, /Sem chave/);
  });

  it("prepares the included photo using paths relative to the request, not cwd", async (t) => {
    if (!ffmpegAvailable) return t.skip("FFmpeg absent; no install/network fallback");
    const cwd = await tempFor(t);
    const data = assertDryRun(await cli(["analyze", "--request-file", requestFile("photo-analysis.json"), "--dry-run", "--json"], { cwd }), ["text", "image"]);
    // O pedido fixa o modelo de box (Jev 1.14); o default do CLI é o oficial.
    assert.equal(data.model, "typesafe/jev-1.14");
    assert.equal(data.media.length, 1);
    assert.equal(data.media[0].name, "photo.png");
    assert.equal(data.media[0].metadata_stripped, true);
    assert.equal(data.safety.visual_auto_disabled, true);
    assert.deepEqual(await fs.readdir(cwd), [], "dry-run must not leave output in the working directory");
  });

  it("accepts repeated local --image flags without leaking synthetic media bytes", async () => {
    const data = assertDryRun(await cli(["analyze", "--image", PHOTO, "--image", PHOTO, "--questions", QUESTION_JSON,
      "--no-preprocess", "--dry-run", "--json"]), ["text", "image"]);
    assert.equal(data.media.length, 2);
    assert.equal(new Set(data.media.map((entry) => entry.id)).size, 2);
    const bytes = await fs.readFile(PHOTO);
    assert.ok(!JSON.stringify(data).includes(bytes.toString("base64").slice(0, 96)));
  });

  it("prepares the included frames request through the CLI with explicit coverage metadata", async (t) => {
    if (!requireVideoTools(t)) return;
    const data = assertDryRun(await cli(["analyze", "--request-file", requestFile("video-frames.json"), "--dry-run", "--json"]), ["text", "image"]);
    assert.equal(data.model, "typesafe/jev-1.14");
    const video = data.media[0];
    assert.equal(video.mode, "frames");
    assert.equal(video.frames.length, 4);
    assert.equal(video.sampling.continuous_coverage, false);
    assert.equal(video.sampling.audio_analyzed, false);
    assert.equal(video.sampling.timestamp_basis, "requested_seek_seconds_not_exact_pts");
  });

  it("prepares native video offline from both the included request and implicit-model CLI flags", async (t) => {
    if (!requireVideoTools(t, false)) return;
    for (const args of [
      ["--request-file", requestFile("video-native.json")],
      ["--video", CLIP, "--video-mode", "native", "--questions", QUESTION_JSON],
    ]) {
      const data = assertDryRun(await cli(["analyze", ...args, "--dry-run", "--json"]), ["text", "video"]);
      assert.equal(data.model, NATIVE_MODEL);
      assert.equal(data.media[0].mode, "native");
      assert.equal(data.media[0].sampling_fps, 2);
      assert.equal(data.media[0].continuous_coverage, false);
    }
  });

  it("writes a new JSON/Markdown dry-run result once and never overwrites it", async (t) => {
    const dir = await tempFor(t);
    for (const [name, json] of [["result.json", true], ["result.md", false]]) {
      const target = path.join(dir, name);
      const args = ["analyze", ...TEXT_ARGS, "--dry-run", "--out", target, ...(json ? ["--json"] : [])];
      const first = await cli(args);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(await fs.readFile(target, "utf8"), first.stdout);
      if (json) assertDryRun(first, ["text"]);
      else assert.match(first.stdout, /DRY-RUN: nenhuma rede, inferência ou upload/);
      const before = await snapshot(dir);
      const repeated = await cli(args);
      assert.equal(repeated.code, 2);
      assert.match(repeated.stderr, /--out exige ficheiro novo/);
      assert.deepEqual(await snapshot(dir), before);
    }
  });
});

describe("invalid CLI input fails before catalog/inference", () => {
  const syntaxCases = [
    ["unknown option", ["analyze", "--imag", PHOTO]],
    ["missing image value", ["analyze", "--image"]],
    ["missing value before another option", ["analyze", "--video", "--json"]],
    ["unexpected positional input", ["analyze", PHOTO]],
    ["dry-run on catalog command", ["models", "--dry-run"]],
    ["media-root on validate", ["validate", "--media-root", MEDIA]],
  ];
  for (const [name, args] of syntaxCases) it(name, async () => {
    const result = await cli(args);
    assert.equal(result.code, 2, result.stdout || result.stderr);
    assert.match(result.stderr, /Erro:/);
  });

  for (const [flag, value] of [["--auto-threshold", "NaN"], ["--auto-threshold", "1.1"], ["--hitl-threshold", "Infinity"]]) {
    it(`rejects ${flag}=${value}`, async () => {
      const result = await cli(["analyze", ...TEXT_ARGS, flag, value, "--json"]);
      assert.equal(result.code, 2, result.stdout || result.stderr);
      assert.match(result.stderr, /Limiares/);
    });
  }
  it("rejects reversed thresholds before preparing/inferencing", async () => {
    const result = await cli(["ask", ...TEXT_ARGS, "--auto-threshold", "0.2", "--hitl-threshold", "0.8", "--json"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Limiares/);
  });

  for (const [flag, value] of [["--retries", "NaN"], ["--retries", "-1"], ["--retries", "1.5"], ["--timeout", "0"], ["--timeout", "Infinity"], ["--timeout", "601"]]) {
    it(`ask rejects transport number ${flag}=${value} without a key/network`, async () => {
      const result = await cli(["ask", ...TEXT_ARGS, flag, value, "--json"]);
      assert.notEqual(result.code, 0);
      assert.match(JSON.parse(result.stdout).error.message, /Opções inválidas/);
    });
  }
  for (const [flag, value] of [["--retries", "NaN"], ["--timeout", "0"]]) {
    it(`analyze dry-run also rejects ${flag}=${value}`, async () => {
      const result = await cli(["analyze", ...TEXT_ARGS, flag, value, "--dry-run", "--json"]);
      assert.notEqual(result.code, 0, "invalid transport options must not be silently accepted by dry-run");
    });
    it(`analyze rejects ${flag}=${value} before even a public catalog lookup`, async () => {
      const result = await cli(["analyze", ...TEXT_ARGS, flag, value, "--json"]);
      assert.notEqual(result.code, 0);
    });
  }

  for (const [flag, value] of [["--fps", "NaN"], ["--fps", "0"], ["--max-frames", "1.5"], ["--max-frames", "65"], ["--start", "-1"], ["--end", "0"]]) {
    it(`rejects video number ${flag}=${value} offline`, async (t) => {
      if (!requireVideoTools(t, false)) return;
      const result = await cli(["analyze", "--video", CLIP, "--questions", QUESTION_JSON, flag, value, "--dry-run", "--json"]);
      assert.equal(result.code, 2, result.stdout || result.stderr);
    });
  }
  it("rejects unknown video modes and native frame options instead of ignoring them", async (t) => {
    const invalidMode = await cli(["analyze", ...TEXT_ARGS, "--video-mode", "continuous", "--dry-run", "--json"]);
    assert.equal(invalidMode.code, 2);
    if (!requireVideoTools(t, false)) return;
    const nativeFps = await cli(["analyze", "--video", CLIP, "--video-mode", "native", "--fps", "2", "--questions", QUESTION_JSON, "--dry-run", "--json"]);
    assert.equal(nativeFps.code, 2);
    assert.match(nativeFps.stdout, /opções do modo frames/);
  });

  it("strict rejects a text warning in ask and experimental photo warnings in dry-run", async () => {
    const questions = { category: { type: "choice", instructions: "Which category fits?", criteria: { red: "Red", blue: "Blue" } } };
    const text = await cli(["ask", "--state", "Offline test", "--questions", JSON.stringify(questions), "--strict", "--json"]);
    assert.equal(text.code, 2);
    assert.ok(JSON.parse(text.stdout).validation.warnings.some((entry) => entry.code === "choice.no_match"));
    const photo = await cli(["analyze", "--request-file", requestFile("photo-analysis.json"), "--no-preprocess", "--strict", "--dry-run", "--json"]);
    assert.equal(photo.code, 2);
    assert.ok(JSON.parse(photo.stdout).validation.warnings.some((entry) => entry.code === "media.experimental"));
  });

  it("invalid --out destinations block before media preparation and preserve every file", async (t) => {
    const dir = await tempFor(t);
    const existing = path.join(dir, "keep.json");
    await fs.writeFile(existing, "PRIVATE_SYNTHETIC_EXISTING_RESULT\n");
    const before = await snapshot(dir);
    for (const target of [existing, dir, path.join(dir, "missing-parent", "result.json")]) {
      const result = await cli(["analyze", ...TEXT_ARGS, "--out", target, "--json"]);
      assert.notEqual(result.code, 0);
      assert.deepEqual(await snapshot(dir), before);
    }
  });
});

describe("MCP stdio with offline preload", () => {
  it("initializes, lists only the two new tools, pings, and ignores notifications/malformed lines", async () => {
    const result = await mcp([
      "this is not JSON", "", rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "offline-test", version: "1" } }),
      rpc(undefined, "notifications/initialized"), rpc(2, "tools/list"), rpc(3, "ping"), rpc(4, "not/a/method"),
      call(5, "not_a_tool", {}),
    ]);
    assert.deepEqual(result.replies.map((reply) => reply.id), [1, 2, 3, 4, 5]);
    const initialized = result.byId.get(1).result;
    assert.equal(initialized.protocolVersion, "2025-06-18");
    assert.equal(initialized.serverInfo.name, "som-openrouter");
    assert.match(initialized.serverInfo.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(initialized.capabilities, { tools: {} });
    const tools = result.byId.get(2).result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), ["evaluate_with_som", "analyze_media_with_som"]);
    assert.deepEqual(tools[0].inputSchema.required, ["state", "questions"]);
    assert.deepEqual(tools[1].inputSchema.required, ["questions"]);
    assert.deepEqual(tools[1].inputSchema.properties.video.properties.mode.enum, ["frames", "native"]);
    assert.deepEqual(result.byId.get(3).result, {});
    assert.equal(result.byId.get(4).error.code, -32601);
    assert.equal(result.byId.get(5).error.code, -32602);
  });

  it("returns isError for validation failures under both current and legacy tool names without network", async () => {
    const result = await mcp([
      call(1, "evaluate_with_som", { state: "Offline", questions: {} }),
      call(2, "evaluate_with_jev", { state: "Offline", questions: {} }),
      call(3, "analyze_media_with_som", { questions: {} }),
      call(4, "analyze_media_with_jev", { questions: {} }),
    ]);
    for (const id of [1, 2]) {
      const payload = toolPayload(result.byId.get(id), true);
      assert.equal(payload.error, "invalid_request");
      assert.ok(payload.validation.errors.some((entry) => entry.code === "questions.empty"));
    }
    for (const id of [3, 4]) {
      const payload = toolPayload(result.byId.get(id), true);
      assert.equal(payload.ok, false);
      assert.ok(payload.validation.errors.some((entry) => entry.code === "questions.empty"));
    }
  });

  for (const configuration of [
    { name: "built-in default", args: [], env: {}, expected: DEFAULT_MODEL },
    { name: "SOM_MODEL default", args: [], env: { SOM_MODEL: LEGACY_MODEL }, expected: LEGACY_MODEL },
    { name: "--model before SOM_MODEL", args: ["--model", NATIVE_MODEL], env: { SOM_MODEL: LEGACY_MODEL }, expected: NATIVE_MODEL },
  ]) {
    it(`propagates ${configuration.name} to both tools and their legacy aliases`, async () => {
      const names = ["evaluate_with_som", "analyze_media_with_som", "evaluate_with_jev", "analyze_media_with_jev"];
      const result = await mcp(names.map((name, i) => call(i + 1, name, { state: "Synthetic offline record", questions: QUESTIONS })), {
        args: configuration.args, env: configuration.env, fake: true,
      });
      assert.equal(result.audit.catalog_calls, 1, "analysis verifies the fake catalog once and reuses it");
      assert.deepEqual(result.audit.decision_models, names.map(() => configuration.expected));
      for (const id of [1, 2, 3, 4]) {
        const payload = toolPayload(result.byId.get(id));
        assert.equal(payload.ok, true);
        assert.equal(payload._som.model_requested, configuration.expected);
        assert.equal(payload._som.model_resolved, configuration.expected);
        assert.equal(payload._som.provider, "offline-test-provider");
        assert.equal(payload.usage.cost, 0);
        assert.deepEqual(payload._jev, payload._som);
      }
    });
  }

  it("an explicit call model takes precedence over both server --model and SOM_MODEL", async () => {
    const names = ["evaluate_with_som", "analyze_media_with_som", "evaluate_with_jev", "analyze_media_with_jev"];
    const result = await mcp(names.map((name, i) => call(i + 1, name, {
      state: "Synthetic offline record", questions: QUESTIONS, model: DEFAULT_MODEL,
    })), { args: ["--model", NATIVE_MODEL], env: { SOM_MODEL: LEGACY_MODEL }, fake: true });
    assert.deepEqual(result.audit.decision_models, names.map(() => DEFAULT_MODEL));
    for (const id of [1, 2, 3, 4]) {
      const payload = toolPayload(result.byId.get(id));
      assert.equal(payload._som.model_requested, DEFAULT_MODEL);
      assert.equal(payload._som.model_resolved, DEFAULT_MODEL);
    }
  });

  it("runs local photo analysis over MCP using only fake catalog/decisions and returns HITL without bytes", async (t) => {
    if (!ffmpegAvailable) return t.skip("FFmpeg absent; no install/network fallback");
    const result = await mcp([call(1, "analyze_media_with_som", {
      questions: QUESTIONS, media: [{ type: "image", path: PHOTO }],
    })], { fake: true });
    const payload = toolPayload(result.byId.get(1));
    assert.equal(payload.ok, true);
    assert.equal(payload.decisions.visible.band, "hitl");
    assert.equal(payload.safety.executes_actions, false);
    assert.equal(payload.media[0].name, "photo.png");
    assert.equal(result.audit.catalog_calls, 1);
    assert.deepEqual(result.audit.decision_models, [DEFAULT_MODEL]);
    const bytes = await fs.readFile(PHOTO);
    assert.ok(!result.stdout.includes(bytes.toString("base64").slice(0, 96)));
  });

  it("maps an invalid fake provider response to isError on both tools", async () => {
    const result = await mcp([
      call(1, "evaluate_with_som", { state: "Synthetic offline", questions: QUESTIONS }),
      call(2, "analyze_media_with_som", { state: "Synthetic offline", questions: QUESTIONS }),
    ], { fake: true, response: "invalid-response" });
    for (const id of [1, 2]) {
      const payload = toolPayload(result.byId.get(id), true);
      assert.equal(payload.ok, false);
      assert.ok(payload.validation.errors.length > 0);
      assert.ok(Object.values(payload.decisions).every((decision) => decision.band === "abstain"));
    }
    assert.deepEqual(result.audit.decision_models, [DEFAULT_MODEL, DEFAULT_MODEL]);
  });

  it("maps synthetic HTTP401 to tool errors, never a successful decision", async () => {
    const result = await mcp([
      call(1, "evaluate_with_som", { state: "Synthetic offline", questions: QUESTIONS }),
      call(2, "analyze_media_with_som", { state: "Synthetic offline", questions: QUESTIONS }),
    ], { fake: true, response: "http401" });
    const evaluate = result.byId.get(1).result;
    assert.equal(evaluate.isError, true);
    assert.match(evaluate.content[0].text, /HTTP 401/);
    const analysis = toolPayload(result.byId.get(2), true);
    assert.equal(analysis.ok, false);
    assert.match(analysis.error, /HTTP 401/);
    assert.ok(!Object.hasOwn(analysis, "decisions"));
    assert.deepEqual(result.audit.decision_models, [DEFAULT_MODEL, DEFAULT_MODEL]);
  });
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function snapshot(root) {
  const entries = [];
  async function visit(absolute) {
    const stat = await fs.lstat(absolute);
    const common = { path: path.relative(root, absolute) || ".", mode: stat.mode, mtime: stat.mtimeMs };
    if (stat.isSymbolicLink()) entries.push({ ...common, kind: "link", target: await fs.readlink(absolute) });
    else if (stat.isDirectory()) {
      entries.push({ ...common, kind: "directory" });
      for (const name of (await fs.readdir(absolute)).sort()) await visit(path.join(absolute, name));
    } else entries.push({ ...common, kind: "file", bytes: stat.size, hash: sha256(await fs.readFile(absolute)) });
  }
  await visit(root);
  return entries;
}
async function projectFor(t) {
  const root = await tempFor(t);
  const project = path.join(root, "existing-project");
  const existing = new Map([
    ["package.json", '{"name":"synthetic-existing-backend","private":true,"scripts":{"test":"existing-test-command"}}\n'],
    [".env", "EXISTING_OFFLINE_SETTING=preserve-this-synthetic-value\n"],
    ["src/auth.mjs", "export const authorizeOwnedUpload = () => false; // project policy\n"],
    ["src/queue.mjs", "export const existingQueue = 'keep';\n"],
    ["src/routes.mjs", "export const existingRoutes = 'keep';\n"],
    ["tests/project.test.mjs", "// Existing project tests are not replaced by vendorization.\n"],
  ]);
  for (const [name, content] of existing) {
    const target = path.join(project, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return { root, project, existing, dest: "server/ai/som", target: path.join(project, "server", "ai", "som") };
}
async function assertProjectPreserved(project, existing) {
  for (const [name, content] of existing) assert.equal(await fs.readFile(path.join(project, name), "utf8"), content, `${name} must be untouched`);
}

describe("integrate export against an existing temporary backend", () => {
  it("dry-run provides hashes without writing directories, manifest or project configuration", async (t) => {
    const p = await projectFor(t);
    const before = await snapshot(p.root);
    const result = await integrate({ project: p.project, dest: p.dest, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.equal(result.project, await fs.realpath(p.project));
    assert.equal(result.destination, p.target);
    const sources = (await fs.readdir(path.join(ROOT, "scripts", "lib"))).filter((name) => /(?:\.mjs|\.d\.mts)$/.test(name)).sort();
    assert.deepEqual(result.files.map((entry) => entry.name), [...sources, "README.md", "LICENSE"]);
    for (const item of result.files) {
      assert.equal(item.action, "create");
      assert.match(item.hash, /^[a-f0-9]{64}$/);
      assert.ok(item.bytes > 0);
      if (item.name !== "README.md") {
        const source = await fs.readFile(item.name === "LICENSE" ? path.join(ROOT, "LICENSE") : path.join(ROOT, "scripts", "lib", item.name));
        assert.equal(item.hash, sha256(source));
        assert.equal(item.bytes, source.length);
      }
    }
    assert.deepEqual(await snapshot(p.root), before, "dry-run means absolutely no filesystem writes");
    await assertProjectPreserved(p.project, p.existing);
  });

  it("installs exact runtime bytes plus SHA-256 manifest and is a true no-op on repetition", async (t) => {
    const p = await projectFor(t);
    const first = await integrate({ project: p.project, dest: p.dest });
    assert.equal(first.ok, true);
    assert.equal(first.dry_run, false);
    assert.ok(first.files.every((entry) => entry.action === "create"));
    const manifest = JSON.parse(await fs.readFile(path.join(p.target, ".som-integration.json"), "utf8"));
    assert.equal(manifest.schema, "som-integration/1");
    assert.equal(manifest.skill_version, first.skill_version);
    assert.deepEqual(manifest.files, Object.fromEntries(first.files.map((entry) => [entry.name, entry.hash])));
    for (const item of first.files) {
      const installed = await fs.readFile(path.join(p.target, item.name));
      assert.equal(sha256(installed), item.hash);
      assert.equal(installed.length, item.bytes);
      if (item.name !== "README.md") assert.deepEqual(installed, await fs.readFile(item.name === "LICENSE" ? path.join(ROOT, "LICENSE") : path.join(ROOT, "scripts", "lib", item.name)));
    }
    assert.deepEqual((await fs.readdir(p.target)).sort(), [...first.files.map((entry) => entry.name), ".som-integration.json"].sort());
    await assertProjectPreserved(p.project, p.existing);
    const beforeRepeat = await snapshot(p.root);
    const repeated = await integrate({ project: p.project, dest: p.dest });
    assert.ok(repeated.files.every((entry) => entry.action === "unchanged"));
    assert.deepEqual(await snapshot(p.root), beforeRepeat, "idempotence includes bytes, metadata and manifest");
    await assertProjectPreserved(p.project, p.existing);
  });

  it("a late conflict on first install prevents ALL earlier planned creates", async (t) => {
    const p = await projectFor(t);
    await fs.mkdir(p.target, { recursive: true });
    await fs.writeFile(path.join(p.target, "README.md"), "Local adapter documentation must survive.\n");
    const before = await snapshot(p.root);
    await assert.rejects(integrate({ project: p.project, dest: p.dest }), /Conflito local em README\.md/);
    assert.deepEqual(await snapshot(p.root), before, "no modules, directory entries or manifest may be written before conflict detection");
    await assertProjectPreserved(p.project, p.existing);
  });

  it("a late tracked conflict also prevents earlier eligible updates and manifest changes", async (t) => {
    const p = await projectFor(t);
    await integrate({ project: p.project, dest: p.dest });
    const oldBytes = Buffer.from("// A previously installed runtime revision.\n");
    await fs.writeFile(path.join(p.target, "capabilities.mjs"), oldBytes);
    const manifestPath = path.join(p.target, ".som-integration.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.files["capabilities.mjs"] = sha256(oldBytes); // recognized old version, eligible for update
    await fs.writeFile(manifestPath, JSON.stringify(manifest) + "\n");
    await fs.writeFile(path.join(p.target, "README.md"), "An unrecorded local change: block the entire update.\n");
    const before = await snapshot(p.root);
    await assert.rejects(integrate({ project: p.project, dest: p.dest }), /Conflito local em README\.md/);
    assert.deepEqual(await snapshot(p.root), before);
    await assertProjectPreserved(p.project, p.existing);
  });

  it("an unknown manifest is never silently replaced and prevents all writes", async (t) => {
    const p = await projectFor(t);
    await fs.mkdir(p.target, { recursive: true });
    await fs.writeFile(path.join(p.target, ".som-integration.json"), JSON.stringify({ schema: "some-other-tool/1", files: {} }) + "\n");
    const before = await snapshot(p.root);
    await assert.rejects(integrate({ project: p.project, dest: p.dest }), /Manifesto existente desconhecido/);
    assert.deepEqual(await snapshot(p.root), before);
  });

  it("rejects absolute/root/dot/traversal destinations without touching the project or sibling", async (t) => {
    const p = await projectFor(t);
    const outside = path.join(p.root, "outside-project");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "Synthetic outside content\n");
    const before = await snapshot(p.root);
    for (const dest of [outside, ".", "..", "../outside-project/runtime", "server/../runtime", "server/./runtime", "C:escape", ""]) {
      await assert.rejects(integrate({ project: p.project, dest }), /dest|relativo|raiz|escapar/);
      assert.deepEqual(await snapshot(p.root), before, `invalid destination ${JSON.stringify(dest)} must not write`);
    }
  });

  it("rejects an escaping symlink/junction destination before writing anything", async (t) => {
    const p = await projectFor(t);
    const outside = path.join(p.root, "outside-project");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "Do not write through this link.\n");
    const link = path.join(p.project, "linked-outside");
    try { await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip(`OS cannot create a test symlink/junction: ${error.code}`);
      throw error;
    }
    const before = await snapshot(p.root);
    for (const dest of ["linked-outside", "linked-outside/runtime"]) {
      await assert.rejects(integrate({ project: p.project, dest }), /symlink.*escapa|Destino.*escapa/);
      assert.deepEqual(await snapshot(p.root), before);
    }
    await assertProjectPreserved(p.project, p.existing);
  });
});

function fakeUploadResult(ok = true) {
  return {
    ok, analysis: { narrative_source: "deterministic_local_templates", findings: [] },
    decisions: { visible: { value: true, band: "hitl" } }, media: [{ id: "upload", type: "image" }],
    usage: { input_tokens: 1, output_tokens: 0, cost: 0 },
    _som: { model_resolved: DEFAULT_MODEL, generation_id: "offline-upload-generation" },
  };
}
function serviceOptions(overrides = {}) {
  return {
    authorizeUpload: async () => true,
    resolveUpload: async () => ({ type: "image", path: PHOTO }),
    runLimited: async (fn) => fn(), mediaRoot: MEDIA, questions: QUESTIONS,
    policy: "Server-owned synthetic upload policy; manual review is required.",
    analyzeFn: async () => fakeUploadResult(), ...overrides,
  };
}

describe("existing upload-service integration with injected project hooks", () => {
  it("requires real hook functions and server-owned configuration at construction", () => {
    for (const field of ["authorizeUpload", "resolveUpload", "runLimited", "analyzeFn"]) {
      assert.throws(() => createUploadAnalysisService(serviceOptions({ [field]: null })), TypeError);
    }
    for (const field of ["mediaRoot", "questions", "policy"]) {
      assert.throws(() => createUploadAnalysisService(serviceOptions({ [field]: null })), TypeError);
    }
  });

  it("validates the opaque upload ID and actor before even authorizing or looking up a file", async () => {
    const calls = [];
    const service = createUploadAnalysisService(serviceOptions({
      authorizeUpload: async () => { calls.push("auth"); return true; },
      resolveUpload: async () => { calls.push("lookup"); return { type: "image", path: PHOTO }; },
      analyzeFn: async () => { calls.push("analyze"); return fakeUploadResult(); },
    }));
    for (const input of [{ uploadId: "owned" }, { actor: {}, uploadId: "../other" }, { actor: {}, uploadId: "" }, { actor: {}, uploadId: "x".repeat(129) }, { actor: {}, uploadId: 1 }]) {
      await assert.rejects(service(input), (error) => error instanceof UploadAnalysisError && error.status === 400 && error.code === "invalid_request");
    }
    assert.deepEqual(calls, []);
  });

  it("authorization denial precedes lookup, queue use and analysis", async () => {
    const calls = [];
    const actor = { id: "synthetic-owner" };
    const service = createUploadAnalysisService(serviceOptions({
      authorizeUpload: async (args) => { calls.push("auth"); assert.deepEqual(args, { actor, uploadId: "not-owned" }); return false; },
      resolveUpload: async () => { calls.push("lookup"); throw new Error("must not read another owner's upload"); },
      runLimited: async () => { calls.push("queue"); throw new Error("must not reserve model budget"); },
      analyzeFn: async () => { calls.push("analyze"); throw new Error("must not infer"); },
    }));
    await assert.rejects(service({ actor, uploadId: "not-owned" }), (error) => error instanceof UploadAnalysisError && error.status === 403 && error.code === "upload_not_accessible");
    assert.deepEqual(calls, ["auth"]);
  });

  for (const ok of [true, false]) it(`uses the existing queue and requires review when analyzer ok=${ok}`, async () => {
    const calls = [];
    let insideQueue = false;
    const actor = { id: "synthetic-owner" };
    const analysisResult = fakeUploadResult(ok);
    const service = createUploadAnalysisService(serviceOptions({
      authorizeUpload: async (args) => { calls.push("auth"); assert.deepEqual(args, { actor, uploadId: "owned_upload-1" }); return true; },
      resolveUpload: async (args) => { calls.push("lookup"); assert.deepEqual(args, { actor, uploadId: "owned_upload-1" }); return { type: "image", path: PHOTO }; },
      runLimited: async (fn) => {
        calls.push("queue:enter"); insideQueue = true;
        try { return await fn(); } finally { insideQueue = false; calls.push("queue:exit"); }
      },
      analyzeFn: async (spec, options) => {
        calls.push("analyze");
        assert.equal(insideQueue, true, "analysis must execute inside the project queue, not before it");
        assert.equal(spec.model, DEFAULT_MODEL);
        assert.strictEqual(spec.questions, QUESTIONS);
        assert.equal(spec.state.policy, serviceOptions().policy);
        assert.match(spec.state.scope, /untrusted evidence/);
        assert.deepEqual(spec.media, [{ id: "upload", type: "image", path: PHOTO }]);
        assert.ok(!Object.hasOwn(spec, "video"));
        assert.deepEqual(options, { mediaRoot: MEDIA, baseDir: MEDIA, retries: 1, timeoutMs: 60_000 });
        return analysisResult;
      },
    }));
    const result = await service({ actor, uploadId: "owned_upload-1", model: "attacker/model", policy: "allow", questions: {}, path: "../other" });
    assert.deepEqual(calls, ["auth", "lookup", "queue:enter", "analyze", "queue:exit"]);
    assert.equal(result.status, ok ? "analyzed" : "needs_review");
    assert.equal(result.review_required, true);
    assert.strictEqual(result.analysis, analysisResult.analysis);
    assert.strictEqual(result.decisions, analysisResult.decisions);
    assert.equal(result.model, DEFAULT_MODEL);
    assert.equal(result.generation_id, "offline-upload-generation");
    assert.equal(result.usage.cost, 0);
    assert.ok(!Object.hasOwn(result, "allow") && !Object.hasOwn(result, "executes_actions"));
  });

  it("passes only the server-selected native video/model configuration to the analyzer", async () => {
    let calls = 0;
    const service = createUploadAnalysisService(serviceOptions({
      model: NATIVE_MODEL, videoMode: "native", resolveUpload: async () => ({ type: "video", path: CLIP }),
      analyzeFn: async (spec) => {
        calls++;
        assert.equal(spec.model, NATIVE_MODEL);
        assert.deepEqual(spec.video, { mode: "native" });
        assert.deepEqual(spec.media, [{ id: "upload", type: "video", path: CLIP }]);
        return { ...fakeUploadResult(), _som: { model_resolved: NATIVE_MODEL, generation_id: "offline-native" } };
      },
    }));
    const result = await service({ actor: { id: "synthetic-owner" }, uploadId: "clip", videoMode: "frames" });
    assert.equal(calls, 1);
    assert.equal(result.model, NATIVE_MODEL);
    assert.equal(result.review_required, true);
  });

  it("rejects unsupported storage results before using the model queue", async () => {
    let queued = 0;
    for (const upload of [null, { type: "text", path: PHOTO }, { type: "image", path: null }]) {
      const service = createUploadAnalysisService(serviceOptions({ resolveUpload: async () => upload,
        runLimited: async () => { queued++; throw new Error("must not queue"); } }));
      await assert.rejects(service({ actor: { id: "owner" }, uploadId: "owned" }), (error) => error instanceof UploadAnalysisError && error.status === 415 && error.code === "unsupported_upload");
    }
    assert.equal(queued, 0);
  });

  it("a synthetic provider401 is a manual-review failure, never allow or an analyzed result", async () => {
    const calls = [];
    const service = createUploadAnalysisService(serviceOptions({
      authorizeUpload: async () => { calls.push("auth"); return true; },
      resolveUpload: async () => { calls.push("lookup"); return { type: "image", path: PHOTO }; },
      runLimited: async (fn) => { calls.push("queue"); return fn(); },
      analyzeFn: async () => {
        calls.push("analyze");
        throw Object.assign(new Error("PRIVATE_SYNTHETIC_PROVIDER_ERROR_MUST_NOT_ESCAPE"), { status: 401 });
      },
    }));
    let returned = false;
    await assert.rejects(async () => {
      await service({ actor: { id: "owner" }, uploadId: "owned" });
      returned = true;
    }, (error) => {
      assert.ok(error instanceof UploadAnalysisError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "analysis_unavailable_manual_review");
      assert.ok(!error.message.includes("PRIVATE_SYNTHETIC_PROVIDER_ERROR"));
      assert.ok(!Object.hasOwn(error, "allow"));
      return true;
    });
    assert.equal(returned, false);
    assert.deepEqual(calls, ["auth", "lookup", "queue", "analyze"]);
  });
});
