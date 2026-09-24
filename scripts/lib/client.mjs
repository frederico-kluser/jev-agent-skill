// client.mjs — Transporte HTTP de baixa latência para a Decisions API do Jev
// via OpenRouter. Zero dependências (node:http2 + node:https nativos).
//
// Física de latência (ver references/latencia.md): cada processo efémero que
// abre socket novo paga DNS + TCP + TLS (~3-4 RTT). Este cliente mantém
// `keepAlive` com soquetes quentes e reporta `socket_reused` na telemetria.
//
// Modos de transporte (env JEV_TRANSPORT ou opts.transportMode):
//   h1 (padrão) — HTTP/1.1 keep-alive: 1 socket quente por ligação em rajada,
//                 cada pedido com o seu cwnd. Medido como melhor distribuição de
//                 latência em rajadas paralelas (ver references/benchmarks.md).
//   h2          — HTTP/2 multiplexado: 1 canal TLS para N pedidos (poupa
//                 sockets; sofre ondas de serialização em rajadas frias).
//   auto        — tenta h2 e cai para h1 em erro de transporte.
//
// Retentativas: 429/529/5xx e erros de rede → backoff exponencial com jitter,
// honrando `Retry-After` (limitado a maxRetryWaitMs). 400/401/402/403/404/413/422
// são terminais (não repetir) — decisão rápida exige falhar rápido.

import https from "node:https";
import http2 from "node:http2";
import { URL } from "node:url";

export const SURFACES = Object.freeze({
  decisions: "https://openrouter.ai/api/alpha/decisions", // Decisions API (alpha)
  systemone: "https://openrouter.ai/api/v1/systemone",    // compatível com SDK TypeSafe
  typesafe: "https://api.typesafe.ai/v1/systemone",       // superfície nativa
});

export const DEFAULT_MODEL = "typesafe/jev-1.13";

// Códigos que VALEM a pena repetir (transientes).
const RETRYABLE = new Set([429, 500, 502, 503, 504, 524, 529]);
// Códigos terminais: repetir só desperdiça tempo.
const TERMINAL = new Set([400, 401, 402, 403, 404, 413, 422]);

const TERMINAL_HINTS = {
  400: "Pedido malformado — corrija state/questions (a mensagem do erro costuma nomear o campo).",
  401: "Chave inválida ou em falta — ver OPENROUTER_API_KEY (https://openrouter.ai/settings/keys).",
  402: "Créditos insuficientes — adicione créditos em https://openrouter.ai/credits.",
  403: "Permissões insuficientes para esta chave.",
  404: "Modelo/recurso inexistente — confirme o ID do modelo (ex.: typesafe/jev-1.13).",
  413: "Payload grande demais — reduza o state (limite: 64k tokens; state+pergunta mais longa ≤ 32k).",
  422: "Falha de validação do lado da API — a mensagem nomeia o campo ofensor.",
};

export class JevClientError extends Error {
  constructor(message, { status = 0, body = null, attempts = 0, retriable = false } = {}) {
    super(message);
    this.name = "JevClientError";
    this.status = status;
    this.body = body;
    this.attempts = attempts;
    this.retriable = retriable;
  }
}

export function resolveApiKey(env = process.env) {
  return env.OPENROUTER_API_KEY || env.JEV_API_KEY || env.TYPESAFE_API_KEY || null;
}

export function resolveSurface(env = process.env) {
  if (env.JEV_BASE_URL) return env.JEV_BASE_URL.replace(/\/$/, "");
  const s = (env.JEV_SURFACE || "decisions").toLowerCase();
  return SURFACES[s] || SURFACES.decisions;
}

// ---------------------------------------------------------------------------
// HTTP/1.1 — pool de soquetes persistentes por host (warm sockets)
// ---------------------------------------------------------------------------
const agents = new Map();
function agentFor(url) {
  if (!agents.has(url.origin)) {
    agents.set(url.origin, new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 60_000,
      maxSockets: 50,     // suporta fan-out de subagentes em paralelo
      maxFreeSockets: 10,
      timeout: 30_000,
    }));
  }
  return agents.get(url.origin);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/** POST HTTP/1.1 keep-alive. `req.reusedSocket` = socket quente reutilizado. */
export function post(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      agent: agentFor(url),
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          // req.reusedSocket: true quando o pedido reutilizou socket quente do pool
          // (sock.reused NÃO existe em TLSSocket — comum armadilha).
          socketReused: Boolean(req.reusedSocket),
          raw: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP/2 — uma sessão TLS por host, N streams multiplexados
// ---------------------------------------------------------------------------
const h2Sessions = new Map();
function sessionFor(url) {
  const key = url.origin;
  let s = h2Sessions.get(key);
  if (s && !s.closed && !s.destroyed) return { session: s, reused: true };
  if (s) { try { s.destroy(); } catch { /* já morta */ } }
  s = http2.connect(url.origin, { settings: { enablePush: false } });
  // Só remove a entrada se AINDA for esta sessão: o evento 'close' de uma sessão
  // antiga chega assincronamente e apagaria a entrada da sessão nova (leak).
  const evict = () => { if (h2Sessions.get(key) === s) h2Sessions.delete(key); };
  s.on("error", evict);
  s.on("close", evict);
  h2Sessions.set(key, s);
  return { session: s, reused: false };
}

/** POST HTTP/2 multiplexado. Headers de conexão são removidos (proibidos em h2). */
export function postH2(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const { session, reused } = sessionFor(url);
    const h2headers = { ":method": "POST", ":path": url.pathname };
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding" || lk === "host") continue;
      h2headers[lk] = v;
    }
    const req = session.request(h2headers);
    const timer = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    const chunks = [];
    let status = 0;
    let respHeaders = {};
    req.on("response", (h) => {
      status = Number(h[":status"]) || 0;
      respHeaders = h;
    });
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      clearTimeout(timer);
      resolve({
        statusCode: status,
        headers: respHeaders,
        socketReused: reused,
        raw: Buffer.concat(chunks).toString("utf8"),
      });
    });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.end(body);
  });
}

/**
 * Transporte auto: tenta h2 e cai para h1 em erro de TRANSPORTE.
 * Respostas da API (mesmo não-2xx) passam sempre — quem decide retentativas é o decide().
 */
export function autoTransport(h2Impl = postH2, h1Impl = post) {
  return async (url, opts) => {
    try {
      return await h2Impl(url, opts);
    } catch {
      return await h1Impl(url, opts);
    }
  };
}

function transportFor(opts, env) {
  if (typeof opts.transport === "function") return opts.transport;
  const mode = (opts.transportMode || env.JEV_TRANSPORT || "h1").toLowerCase();
  if (mode === "h2") return postH2;
  if (mode === "auto") return autoTransport();
  return post;
}

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

/**
 * Envia uma requisição Decisions e devolve a resposta + telemetria.
 * `transport` é injetável para selftest offline.
 */
export async function decide(request, opts = {}) {
  const env = opts.env || process.env;
  const apiKey = opts.apiKey || resolveApiKey(env);
  const endpoint = opts.endpoint || resolveSurface(env);
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? 10_000;
  const transport = transportFor(opts, env);
  const url = new URL(endpoint);

  if (!apiKey) {
    throw new JevClientError(
      "Sem chave de API. Defina OPENROUTER_API_KEY (recomendado, via https://openrouter.ai/keys) ou JEV_API_KEY/TYPESAFE_API_KEY.",
      { retriable: false });
  }

  const body = JSON.stringify(request);
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Connection": "keep-alive",
    ...(opts.headers || {}),
  };

  const t0 = performance.now();
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await transport(url, { headers, body, timeoutMs });
    } catch (netErr) {
      lastErr = new JevClientError(`Falha de rede: ${netErr.message}`, { retriable: true, attempts: attempt + 1 });
      if (attempt < retries) { await delay(Math.min(backoffMs(attempt), maxRetryWaitMs)); continue; }
      throw lastErr;
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      let parsed;
      try {
        parsed = JSON.parse(res.raw);
      } catch {
        throw new JevClientError("Resposta 200 mas corpo não é JSON válido.", { status: 200, body: res.raw.slice(0, 500), attempts: attempt + 1 });
      }
      return {
        response: parsed,
        telemetry: {
          latency_ms: Math.round(performance.now() - t0),
          attempts: attempt + 1,
          socket_reused: Boolean(res.socketReused),
          endpoint,
          surface: Object.keys(SURFACES).find((k) => SURFACES[k] === endpoint) || "custom",
          model_requested: request.model,
          model_resolved: parsed.model ?? null,
          provider: parsed.provider ?? null,
          cost_usd: parsed.usage?.cost ?? null,
          input_tokens: parsed.usage?.input_tokens ?? null,
          output_tokens: parsed.usage?.output_tokens ?? null,
        },
      };
    }

    // Corpo de erro da API (OpenRouter: {error:{code,message}}; TypeSafe varia)
    let errBody = null;
    try { errBody = JSON.parse(res.raw); } catch { errBody = res.raw.slice(0, 300); }
    const apiMsg = errBody?.error?.message || errBody?.message || (typeof errBody === "string" ? errBody : "");

    if (RETRYABLE.has(res.statusCode) && attempt < retries) {
      const ra = parseRetryAfter(res.headers && res.headers["retry-after"]);
      await delay(Math.min(ra ?? backoffMs(attempt), maxRetryWaitMs));
      lastErr = new JevClientError(`HTTP ${res.statusCode}${apiMsg ? `: ${apiMsg}` : ""}`, { status: res.statusCode, body: errBody, retriable: true, attempts: attempt + 1 });
      continue;
    }

    const hint = TERMINAL_HINTS[res.statusCode] || (RETRYABLE.has(res.statusCode) ? "Esgotadas as retentativas." : "Erro não transitório.");
    throw new JevClientError(
      `HTTP ${res.statusCode}${apiMsg ? `: ${apiMsg}` : ""} — ${hint}`,
      { status: res.statusCode, body: errBody, attempts: attempt + 1, retriable: TERMINAL.has(res.statusCode) ? false : true });
  }
  throw lastErr || new JevClientError("Falha desconhecida.", { retriable: true });
}

function backoffMs(attempt) {
  // 250ms, 500ms, 1000ms… + jitter uniforme de até 100ms (evita thundering herd).
  return Math.pow(2, attempt) * 250 + Math.floor(Math.random() * 100);
}

/** Diagnóstico da conta/chave (GET /api/v1/key do OpenRouter). */
export async function checkKey(opts = {}) {
  const env = opts.env || process.env;
  const apiKey = opts.apiKey || resolveApiKey(env);
  if (!apiKey) return { ok: false, error: "Sem OPENROUTER_API_KEY no ambiente." };
  const url = new URL(opts.url || "https://openrouter.ai/api/v1/key");
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: "GET",
      agent: agentFor(url),
      headers: { "Authorization": `Bearer ${apiKey}` },
      timeout: opts.timeoutMs ?? 10_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed = JSON.parse(raw);
          resolve({ ok: res.statusCode === 200, status: res.statusCode, data: parsed.data ?? parsed, socket_reused: Boolean(req.reusedSocket) });
        } catch {
          resolve({ ok: false, status: res.statusCode, error: raw.slice(0, 200) });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

/** Fecha pools e sessões (para scripts de teste terminarem limpos).
 *  Sessões h2 são destroy() — close() gracioso segura o event loop e o
 *  processo nunca termina (armadilha verificada no bench). */
export function closeAgents() {
  for (const a of agents.values()) a.destroy();
  agents.clear();
  for (const s of h2Sessions.values()) { try { s.destroy(); } catch { /* já morta */ } }
  h2Sessions.clear();
}
