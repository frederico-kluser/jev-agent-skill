// client.mjs — Transporte HTTP de baixa latência para a Decisions API do Jev
// via OpenRouter. Zero dependências (node:https nativo).
//
// Física de latência (ver references/latencia.md): cada processo efémero que
// abre socket novo paga DNS + TCP + TLS (~3-4 RTT). Este cliente mantém
// `keepAlive: true` com soquetes quentes e reporta `socket_reused` na
// telemetria — depois da 1ª chamada, a latência colapsa para ~1 RTT.
//
// Retentativas: 429/529/5xx e erros de rede → backoff exponencial com jitter,
// honrando `Retry-After` (regra dos SDKs oficiais: ninguém honra sozinho).
// 400/401/402/403/404/413/422 são terminais (não repetir).

import https from "node:https";
import { URL } from "node:url";

export const SURFACES = Object.freeze({
  decisions: "https://openrouter.ai/api/alpha/decisions", // Decisions API (alpha)
  systemone: "https://openrouter.ai/api/v1/systemone",    // compatível com SDK TypeSafe
  typesafe: "https://api.typesafe.ai/v1/systemone",       // superfície nativa
});

export const DEFAULT_MODEL = "typesafe/jev-1.13";

// Códigos que VALEM a pena repetir (transientes).
const RETRYABLE = new Set([429, 500, 502, 503, 504, 524, 529]);
// Códigos terminais: repetir só desperdiça tempo (decisão rápida exige falhar rápido).
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

/**
 * Pool de soquetes persistentes por host (warm sockets).
 * keepAliveMsecs=60s: o canal TLS fica pronto para a próxima decisão.
 */
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

function post(url, { headers, body, timeoutMs }) {
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

/**
 * Envia uma requisição Decisions e devolve a resposta validada em forma bruta.
 * `transport` é injetável para selftest offline.
 */
export async function decide(request, opts = {}) {
  const env = opts.env || process.env;
  const apiKey = opts.apiKey || resolveApiKey(env);
  const endpoint = opts.endpoint || resolveSurface(env);
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const transport = opts.transport || post;
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
      if (attempt < retries) { await delay(backoffMs(attempt)); continue; }
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
      await delay(ra ?? backoffMs(attempt));
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

/** Fecha os pools (útil em scripts de teste para o processo terminar). */
export function closeAgents() {
  for (const a of agents.values()) a.destroy();
  agents.clear();
}
