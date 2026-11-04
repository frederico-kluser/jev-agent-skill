// Test-only preload: no original network implementation is ever called.
// The parent supplies a whitelisted environment and this synthetic key only.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import https from "node:https";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

const FAKE_KEY = "sk-or-v1-SOM_OFFLINE_TEST_NOT_A_REAL_CREDENTIAL";
const mode = process.env.SOM_TEST_NETWORK === "fake" ? "fake" : "deny";
const responseMode = process.env.SOM_TEST_RESPONSE ?? "valid";
const audit = { mode, catalog_calls: 0, decision_models: [], blocked: [] };
const MODELS = ["typesafe/jev-1.13", "typesafe/jev-1.14", "cloudflare/clef-omni", "perplexity/pplx-decider-v1.2"];

function forbidden(name) {
  audit.blocked.push(name);
  throw new Error(`Network forbidden by SOM offline preload: ${name}`);
}

const block = (name) => () => forbidden(name);
http.request = block("http.request");
http.get = block("http.get");
https.get = block("https.get");
http2.connect = block("http2.connect");
net.connect = block("net.connect");
net.createConnection = block("net.createConnection");
net.Socket.prototype.connect = block("net.Socket.connect");
tls.connect = block("tls.connect");
for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "reverse"]) {
  if (typeof dns[name] === "function") dns[name] = block(`dns.${name}`);
  if (typeof dns.promises[name] === "function") dns.promises[name] = block(`dns.promises.${name}`);
}

function catalogItem(id) {
  return {
    id, canonical_slug: id, endpoints: ["/api/alpha/decisions"],
    architecture: {
      input_modalities: id === "cloudflare/clef-omni" ? ["text", "image", "video", "audio"] : ["text", "image"],
      output_modalities: ["decisions"],
    },
    context_length: 65_536, pricing: { prompt: "0", completion: "0" },
  };
}

globalThis.fetch = async (input, init = {}) => {
  if (mode !== "fake") return forbidden("fetch");
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.href !== "https://openrouter.ai/api/v1/models?output_modalities=decisions" ||
      (init.method && init.method !== "GET")) return forbidden("fetch unexpected target");
  assert.equal(new Headers(init.headers).has("authorization"), false, "public catalog must not receive a key");
  audit.catalog_calls++;
  return { ok: true, status: 200, json: async () => ({ data: MODELS.map(catalogItem) }) };
};

function fakeDecision(request) {
  assert.ok(MODELS.includes(request.model), "fake transport accepts implemented test models only");
  assert.ok(request.questions && Object.keys(request.questions).length > 0, "only valid requests reach the fake transport");
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    if (q.type === "noul") return [id, { type: "noul", noul: 0.99 }];
    if (q.type === "box") return [id, { type: "box", box: { left: 0.1, right: 0.8, top: 0.2, bottom: 0.7 }, confidence: 0.99 }];
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      return [id, { type: "choice", choice: keys[0], confidence: 0.99,
        probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 : 0])) }];
    }
    assert.equal(q.type, "score");
    return [id, { type: "score", score: q.criteria.length - 1, confidence: 0.99,
      probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === q.criteria.length - 1 ? 1 : 0])) }];
  }));
  if (responseMode === "invalid-response") answers[Object.keys(answers)[0]] = { type: "noul", noul: "not-a-probability" };
  return {
    id: `som-offline-generation-${audit.decision_models.length}`, model: request.model,
    provider: "offline-test-provider", answers,
    usage: { input_tokens: 12, output_tokens: 1, cost: 0 },
  };
}

https.request = (input, options, callback) => {
  if (mode !== "fake") return forbidden("https.request");
  const url = new URL(input);
  if (url.href !== "https://openrouter.ai/api/alpha/decisions" || options?.method !== "POST" ||
      typeof callback !== "function") return forbidden("https.request unexpected target");
  assert.equal(options.headers.Authorization, `Bearer ${FAKE_KEY}`, "only the synthetic test key is accepted");
  const request = new EventEmitter();
  const chunks = [];
  let ended = false;
  request.reusedSocket = false;
  request.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
  request.destroy = (error) => { if (error) queueMicrotask(() => request.emit("error", error)); return request; };
  request.setTimeout = () => request;
  request.end = (chunk) => {
    assert.equal(ended, false);
    ended = true;
    if (chunk !== undefined) request.write(chunk);
    queueMicrotask(() => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        assert.equal(body.includes(FAKE_KEY), false);
        const payload = JSON.parse(body);
        const decision = fakeDecision(payload);
        audit.decision_models.push(payload.model);
        const response = new EventEmitter();
        response.statusCode = responseMode === "http401" ? 401 : 200;
        response.headers = { "content-type": "application/json", "x-generation-id": decision.id };
        callback(response);
        response.emit("data", Buffer.from(JSON.stringify(response.statusCode === 401
          ? { error: { code: 401, message: "Synthetic offline authentication failure" } }
          : decision)));
        response.emit("end");
      } catch (error) { request.emit("error", error); }
    });
    return request;
  };
  return request;
};

// Keep named ESM imports guarded too; no escape through node:net/http aliases.
syncBuiltinESMExports();
process.on("exit", () => {
  // Only counts and model IDs: never headers, state, media bytes or credentials.
  process.stderr.write(`SOM_TEST_NETWORK_AUDIT ${JSON.stringify(audit)}\n`);
});
