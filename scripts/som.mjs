#!/usr/bin/env node
// som.mjs — decisões e análises com System One Models reais via OpenRouter.
// Zero dependências. Node >= 20.
//
// Comandos:
//   ask       uma decisão tipada (state + questions) com validação total
//   validate  validação OFFLINE de uma requisição (sem gastar tokens)
//   batch     várias decisões num processo só (soquete quente reutilizado)
//   eval      avaliação calibrada (accuracy + ECE) sobre evals.json rotulados
//   status    estado da chave/endpoint; --check faz uma chamada real
//   selftest  verificação determinística OFFLINE de toda a máquina
//   serve     servidor MCP (stdio) com keep-alive persistente entre decisões
//
// Saída: JSON no stdout (use --json para objeto limpo; texto legível por omissão).
// Exit codes: 0 ok · 1 erro de execução/API · 2 requisição inválida (erros de validação).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  validateRequest, validateResponse, decideBand, DEFAULT_THRESHOLDS, LIMITS,
} from "./lib/validate.mjs";

// client.mjs (node:https + node:http2) e node:readline são carregados SOB DEMANDA:
// `help` e `validate` não pagam o arranque dos módulos de rede (~5-8 ms medidos).
import { DEFAULT_MODEL, profileFor, listDecisionModels } from "./lib/capabilities.mjs";
import { redactMediaOutput } from "./lib/media-info.mjs";
let clientPromise;
const clientLib = () => (clientPromise ??= import("./lib/client.mjs"));

const VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// Helpers de CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  const bools = new Set(["json", "strict", "check", "dry-run", "no-preprocess", "skip-model-check", "fail-on-response-errors", "live", "refresh", "help"]);
  const values = new Set(["model", "state", "state-file", "request-file", "questions-file", "questions", "requests-file", "concurrency", "evals-file", "tolerance", "auto-threshold", "hitl-threshold", "retries", "timeout", "surface", "image", "video", "video-mode", "fps", "max-frames", "start", "end", "media-root", "out", "input"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    if (bools.has(key)) { args.flags[key] = true; continue; }
    if (!values.has(key)) fail(`Opção desconhecida: ${a}. Consulte help.`, 2);
    const next = argv[++i];
    if (next === undefined || next.startsWith("--")) fail(`${a} exige um valor.`, 2);
    if (["image", "video"].includes(key)) args.flags[key] = [...(args.flags[key] ?? []), next];
    else args.flags[key] = next;
  }
  return args;
}

function readJsonFile(p) {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, "utf8");
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (e) {
    fail(`JSON inválido em ${abs}: ${e.message}`);
  }
}

function fail(msg, code = 1) {
  process.stderr.write(`Erro: ${msg}\n`);
  process.exit(code);
}

function solution(msg) {
  process.stderr.write(`Solução: ${msg}\n`);
}

function out(text) { process.stdout.write(redactMediaOutput(text) + "\n"); }

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

function formatReport(report) {
  const lines = [];
  for (const e of report.errors) lines.push(`  ✗ [${e.code}] ${e.where ? e.where + ": " : ""}${e.msg}`);
  for (const w of report.warnings) lines.push(`  ⚠ [${w.code}] ${w.where ? w.where + ": " : ""}${w.msg}`);
  for (const n of report.info) lines.push(`  ℹ [${n.code}] ${n.where ? n.where + ": " : ""}${n.msg}`);
  return lines.join("\n");
}

function loadRequest(flags) {
  if (flags["request-file"]) {
    const req = readJsonFile(flags["request-file"]);
    if (flags.model) req.model = flags.model;
    else if (!req.model) req.model = process.env.SOM_MODEL || process.env.JEV_MODEL || DEFAULT_MODEL;
    return req;
  }
  const req = {};
  if (flags.state) req.state = flags.state;
  else if (flags["state-file"]) {
    const p = path.resolve(flags["state-file"]);
    const raw = fs.readFileSync(p, "utf8");
    // state-file aceita JSON (objeto/array) ou texto puro
    try { req.state = JSON.parse(raw); } catch { req.state = raw; }
  }
  if (flags["questions-file"]) req.questions = readJsonFile(flags["questions-file"]);
  else if (flags.questions) req.questions = JSON.parse(flags.questions);
  req.model = flags.model || process.env.SOM_MODEL || process.env.JEV_MODEL || DEFAULT_MODEL;
  return req;
}

function thresholdsFrom(flags) {
  const thresholds = {
    auto: flags["auto-threshold"] !== undefined ? Number(flags["auto-threshold"]) : DEFAULT_THRESHOLDS.auto,
    hitl: flags["hitl-threshold"] !== undefined ? Number(flags["hitl-threshold"]) : DEFAULT_THRESHOLDS.hitl,
  };
  if (![thresholds.auto, thresholds.hitl].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || thresholds.auto < thresholds.hitl) fail("Limiares exigem 0 <= hitl <= auto <= 1.", 2);
  return thresholds;
}

function concurrencyFrom(flags) {
  const n = Number(flags.concurrency ?? 4);
  if (!Number.isInteger(n) || n < 1 || n > 64) fail("--concurrency exige inteiro 1..64.", 2);
  return n;
}

function enforceVisualReview(validation, responseValidation) {
  if (validation.budget.media_tokens !== 0) {
    for (const d of Object.values(responseValidation.decisions)) if (d.band === "auto") { d.band = "hitl"; d.reason = "multimodal_requires_domain_calibration"; }
  }
}

// ---------------------------------------------------------------------------
// analyze — texto + ficheiros de mídia / relatório tipado reutilizável
// ---------------------------------------------------------------------------
function analysisInput(flags) {
  const spec = flags["request-file"] ? readJsonFile(flags["request-file"]) : {};
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail("Pedido de análise deve ser objeto JSON.", 2);
  if (flags.model) spec.model = flags.model;
  else if (!spec.model && (process.env.SOM_MODEL || process.env.JEV_MODEL)) spec.model = process.env.SOM_MODEL || process.env.JEV_MODEL;
  if (flags.state !== undefined) spec.state = flags.state;
  else if (flags["state-file"]) {
    const raw = fs.readFileSync(path.resolve(flags["state-file"]), "utf8");
    try { spec.state = JSON.parse(raw); } catch { spec.state = raw; }
  }
  if (flags["questions-file"]) spec.questions = readJsonFile(flags["questions-file"]);
  else if (flags.questions) spec.questions = JSON.parse(flags.questions);
  if (flags.image || flags.video) {
    if (spec.media !== undefined && !Array.isArray(spec.media)) fail("media deve ser array.", 2);
    spec.media = [...(spec.media ?? [])];
    for (const kind of ["image", "video"]) {
      if (flags[kind] === true) fail(`--${kind} exige um caminho.`, 2);
      for (const file of flags[kind] ?? []) spec.media.push({ type: kind, path: path.resolve(file) });
    }
  }
  const videoFlags = { "video-mode": "mode", fps: "fps", "max-frames": "max_frames", start: "start_seconds", end: "end_seconds" };
  for (const [flag, key] of Object.entries(videoFlags)) {
    if (flags[flag] !== undefined) {
      spec.video ??= {};
      spec.video[key] = key === "mode" ? flags[flag] : Number(flags[flag]);
    }
  }
  return spec;
}

async function cmdAnalyze(flags) {
  const A = await import("./lib/analyze.mjs");
  try {
    if (flags.out) {
      const target = path.resolve(flags.out);
      if (fs.existsSync(target) || !fs.statSync(path.dirname(target)).isDirectory()) fail("--out exige ficheiro novo numa pasta existente; não sobrescrevemos resultados.", 2);
    }
    const result = await A.analyze(analysisInput(flags), {
      dryRun: Boolean(flags["dry-run"]), strict: Boolean(flags.strict), thresholds: thresholdsFrom(flags),
      baseDir: flags["request-file"] ? path.dirname(path.resolve(flags["request-file"])) : process.cwd(),
      mediaRoot: flags["media-root"] ? path.resolve(flags["media-root"]) : undefined,
      preprocess: !flags["no-preprocess"], checkModel: !flags["skip-model-check"],
      retries: flags.retries !== undefined ? Number(flags.retries) : undefined,
      timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) * 1000 : undefined,
    });
    const text = flags.json ? JSON.stringify(result, null, 2) : A.renderAnalysis(result);
    if (flags.out) fs.writeFileSync(path.resolve(flags.out), text + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    out(text);
    if (!result.ok) process.exitCode = 2;
  } catch (err) {
    if (flags.json) out(JSON.stringify({ ok: false, error: { message: err.message, status: err.status ?? null }, ...(err.validation ? { validation: err.validation } : {}) }, null, 2));
    else {
      process.stderr.write(`Erro: ${err.message}\n`);
      if (err.validation) process.stderr.write(formatReport(err.validation) + "\n");
      solution("Revise o pedido/limites; use --dry-run antes da inferência e models para confirmar as capacidades.");
    }
    process.exitCode = err.exitCode ?? 1;
  } finally { (await clientLib()).closeAgents(); }
}

async function cmdModels(flags) {
  const models = await listDecisionModels({ refresh: Boolean(flags.refresh) });
  const selected = flags.input ? models.filter((m) => m.architecture.input_modalities.includes(flags.input)) : models;
  out(JSON.stringify({ source: "https://openrouter.ai/api/v1/models?output_modalities=decisions", count: selected.length,
    note: "Entradas incluem aliases. Só rotas /api/alpha/decisions; catálogo não prova limites nem calibração.",
    models: selected.map((m) => ({ id: m.id, canonical_slug: m.canonical_slug, input: m.architecture.input_modalities,
      endpoints: m.endpoints, context_length: m.context_length, pricing: m.pricing,
      expiration_date: m.expiration_date, implemented_adapter: profileFor(m.id)?.adapter ?? null,
      box: profileFor(m.id)?.primitives.includes("box") ?? false })) }, null, 2));
}

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------

async function cmdAsk(flags) {
  if (flags.image || flags.video || flags["dry-run"]) return cmdAnalyze(flags);
  const req = loadRequest(flags);
  if (req.media !== undefined) return cmdAnalyze(flags);
  const thresholds = thresholdsFrom(flags);

  const v = validateRequest(req);
  if (!v.ok || (flags.strict && v.warnings.length > 0)) {
    if (flags.json) out(JSON.stringify({ ok: false, validation: v }, null, 2));
    else {
      out(`Requisição INVÁLIDA (${v.errors.length} erro(s), ${v.warnings.length} aviso(s)):`);
      out(formatReport(v));
    }
    process.exit(2);
  }

  let result;
  const C = await clientLib();
  try {
    result = await C.decide(req, {
      retries: flags.retries !== undefined ? Number(flags.retries) : undefined,
      timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) * 1000 : undefined,
    });
  } catch (err) {
    const isApi = err instanceof C.JevClientError;
    if (flags.json) {
      out(JSON.stringify({ ok: false, error: { message: err.message, status: err.status ?? null, retriable: Boolean(err.retriable) } }, null, 2));
    } else {
      process.stderr.write(`Erro: ${err.message}\n`);
      if (isApi && err.status === 402) solution("Adicione créditos em https://openrouter.ai/credits e repita.");
      else if (isApi && err.status === 401) solution("Exporte OPENROUTER_API_KEY (https://openrouter.ai/keys) e repita.");
    }
    process.exit(1);
  }

  const rv = validateResponse(req, result.response, thresholds);
  enforceVisualReview(v, rv);
  const payload = {
    ok: rv.ok,
    answers: result.response.answers,
    decisions: rv.decisions,
    validation: { errors: rv.errors, warnings: [...v.warnings, ...rv.warnings], info: v.info },
    usage: result.response.usage ?? null,
    _jev: {
      ...result.telemetry,
      model_resolved: result.response.model ?? result.telemetry.model_resolved,
      id: result.response.id ?? null,
    },
  };

  payload._som = payload._jev;
  if (flags.json) {
    out(JSON.stringify(payload, null, 2));
  } else {
    out(`# Decisão SOM (${payload._jev.latency_ms} ms · socket ${payload._jev.socket_reused ? "QUENTE ✓" : "frio (1ª chamada)"})`);
    for (const [qid, d] of Object.entries(payload.decisions)) {
      const extra = d.basis === "noul_certainty"
        ? `p(sim)=${d.p_yes} certeza=${d.certainty}`
        : `confiança=${d.confidence}`;
      out(`  ${qid}: ${JSON.stringify(d.value)} → [${d.band.toUpperCase()}] ${extra}${d.ambiguous ? " (ambíguo)" : ""}`);
    }
    if (payload.usage) out(`  tokens: ${payload.usage.input_tokens} entrada / ${payload.usage.output_tokens} saída${payload._jev.cost_usd != null ? ` · custo $${payload._jev.cost_usd}` : ""}`);
    const all = [...payload.validation.errors, ...payload.validation.warnings, ...payload.validation.info];
    if (all.length > 0) {
      out(`Validação (${payload.validation.errors.length} erro(s), ${payload.validation.warnings.length} aviso(s)):`);
      out(formatReport({ errors: payload.validation.errors, warnings: payload.validation.warnings, info: payload.validation.info }));
    }
  }
  if (!rv.ok) process.exitCode = 2;
  C.closeAgents();
}

// ---------------------------------------------------------------------------
// validate (offline)
// ---------------------------------------------------------------------------

function cmdValidate(flags) {
  const req = loadRequest(flags);
  const v = validateRequest(req);
  if (flags.json) {
    out(JSON.stringify({ ...v, budget_limits: v.budget.limits }, null, 2));
  } else {
    out(`Requisição ${v.ok ? "VÁLIDA" : "INVÁLIDA"} — ${v.errors.length} erro(s), ${v.warnings.length} aviso(s), ${v.info.length} nota(s).`);
    out(`Orçamento de TEXTO estimado: state=${v.budget.state_tokens} tok · perguntas=${v.budget.questions_tokens} tok · total=${v.budget.total_tokens} tok (limite ${v.budget.limits?.total}; state+pergunta mais longa=${v.budget.state_tokens + v.budget.longest_question_tokens}/${v.budget.limits?.state_plus_longest_q}; tokens de mídia=${v.budget.media_tokens})`);
    const rep = formatReport(v);
    if (rep) out(rep);
  }
  process.exit(v.ok && !(flags.strict && v.warnings.length > 0) ? 0 : 2);
}

// ---------------------------------------------------------------------------
// batch — várias decisões, um processo, socket quente
// ---------------------------------------------------------------------------

async function cmdBatch(flags) {
  const items = readJsonFile(flags["requests-file"]);
  if (!Array.isArray(items)) fail("--requests-file deve conter um array de requisições { state, questions, model? }.");
  const thresholds = thresholdsFrom(flags);
  const concurrency = concurrencyFrom(flags);
  const results = new Array(items.length);
  const C = await clientLib();

  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const req = { model: flags.model || process.env.SOM_MODEL || process.env.JEV_MODEL || DEFAULT_MODEL, ...items[i] };
      const v = validateRequest(req);
      if (!v.ok || (flags.strict && v.warnings.length > 0)) {
        results[i] = { index: i, ok: false, validation: v };
        continue;
      }
      try {
        const r = await C.decide(req, { retries: flags.retries !== undefined ? Number(flags.retries) : undefined, timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) * 1000 : undefined });
        const rv = validateResponse(req, r.response, thresholds);
        enforceVisualReview(v, rv);
        results[i] = {
          index: i, ok: rv.ok,
          answers: r.response.answers,
          decisions: rv.decisions,
          validation: { errors: rv.errors, warnings: [...v.warnings, ...rv.warnings] },
          _som: r.telemetry,
          _jev: r.telemetry,
        };
      } catch (err) {
        results[i] = { index: i, ok: false, error: { message: err.message, status: err.status ?? null } };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  out(JSON.stringify({
    ok: results.every((r) => r.ok),
    count: results.length,
    latency: {
      total_ms: Math.round(results.reduce((a, r) => a + (r._jev?.latency_ms || 0), 0)),
      max_ms: Math.max(...results.map((r) => r._jev?.latency_ms || 0)),
      sockets_warm: results.filter((r) => r._jev?.socket_reused).length,
    },
    results,
  }, null, 2));
  C.closeAgents();
}

// ---------------------------------------------------------------------------
// eval — calibração (accuracy, confiança média, ECE) sobre casos rotulados
// ---------------------------------------------------------------------------

async function cmdEval(flags) {
  const cases = readJsonFile(flags["evals-file"] || "evals/evals.json");
  if (!Array.isArray(cases)) fail("O ficheiro de evals deve ser um array de casos { name, state, questions, expected }.");
  const thresholds = thresholdsFrom(flags);
  const concurrency = concurrencyFrom(flags);
  const C = await clientLib();

  // Workers paralelos (socket h2 multiplexado ou h1 em pool) — eval grande deixa
  // de ser N×latência redonda.
  const rows = [];
  let idx = 0;
  async function worker() {
    while (idx < cases.length) {
      const c = cases[idx++];
      const req = { model: flags.model || process.env.SOM_MODEL || process.env.JEV_MODEL || DEFAULT_MODEL, state: c.state, questions: c.questions };
      const v = validateRequest(req);
      if (!v.ok || (flags.strict && v.warnings.length > 0)) { rows.push({ name: c.name, skipped: true, reason: "invalid_request", errors: v.errors }); continue; }
      let resp;
      try {
        const r = await C.decide(req, { retries: flags.retries !== undefined ? Number(flags.retries) : undefined, timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) * 1000 : undefined });
        resp = r.response;
      } catch (err) {
        rows.push({ name: c.name, skipped: true, reason: err.message });
        continue;
      }
      const rv = validateResponse(req, resp, thresholds);
      if (!rv.ok) { rows.push({ name: c.name, skipped: true, reason: "invalid_response", errors: rv.errors }); continue; }
      for (const [qid, expected] of Object.entries(c.expected || {})) {
        const a = resp.answers[qid];
        if (!a) { rows.push({ name: c.name, qid, skipped: true, reason: "no_answer" }); continue; }
        if (a.type === "box") { rows.push({ name: c.name, qid, skipped: true, reason: "box_requires_presence_and_spatial_iou_eval" }); continue; }
        let predicted, correct, confidence;
        if (a.type === "noul") {
          predicted = a.noul >= 0.5;
          correct = predicted === Boolean(expected);
          confidence = Math.max(a.noul, 1 - a.noul);
        } else if (a.type === "choice") {
          predicted = a.choice;
          correct = predicted === expected;
          confidence = a.confidence ?? 0.5;
        } else {
          predicted = a.score;
          const tol = flags.tolerance !== undefined ? Number(flags.tolerance) : 0.5;
          correct = Math.abs(predicted - Number(expected)) <= tol;
          confidence = a.confidence ?? 0.5;
        }
        rows.push({ name: c.name, qid, type: a.type, expected, predicted, correct, confidence: Math.round(confidence * 1e3) / 1e3, band: rv.decisions[qid]?.band });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  rows.sort((a, b) => (a.name + (a.qid || "")).localeCompare(b.name + (b.qid || "")));

  const scored = rows.filter((r) => r.correct !== undefined);
  const n = scored.length;
  const accuracy = n ? scored.filter((r) => r.correct).length / n : null;
  const meanConf = n ? scored.reduce((a, r) => a + r.confidence, 0) / n : null;

  // Distribuição por banda: que fração do tráfego é executável sem humano
  // (a "poupança real" — ver references/validacao.md §Bandas).
  const band_distribution = { auto: 0, hitl: 0, abstain: 0 };
  for (const r of scored) if (r.band) band_distribution[r.band] = (band_distribution[r.band] || 0) + 1;

  // Expected Calibration Error (10 bins): |acc - conf| ponderado pelo tamanho do bin.
  const bins = Array.from({ length: 10 }, () => []);
  for (const r of scored) bins[Math.min(9, Math.floor(r.confidence * 10))].push(r);
  let ece = 0;
  const binReport = [];
  for (let b = 0; b < 10; b++) {
    const bin = bins[b];
    if (bin.length === 0) continue;
    const acc = bin.filter((r) => r.correct).length / bin.length;
    const conf = bin.reduce((a, r) => a + r.confidence, 0) / bin.length;
    ece += (bin.length / n) * Math.abs(acc - conf);
    binReport.push({ bin: `${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`, count: bin.length, accuracy: round3(acc), mean_confidence: round3(conf) });
  }

  const report = {
    cases: cases.length,
    scored_answers: n,
    accuracy: accuracy !== null ? round3(accuracy) : null,
    mean_confidence: meanConf !== null ? round3(meanConf) : null,
    ece: n ? round3(ece) : null,
    band_distribution,
    calibration_bins: binReport,
    rows,
  };
  out(JSON.stringify(report, null, 2));
  C.closeAgents();
}

function round3(x) { return Math.round(x * 1e3) / 1e3; }

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus(flags) {
  const C = await clientLib();
  const key = C.resolveApiKey();
  const info = {
    key: key ? `${key.slice(0, 6)}…${key.slice(-4)} (mascarada)` : "AUSENTE",
    key_source: process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY" : process.env.JEV_API_KEY ? "JEV_API_KEY" : process.env.TYPESAFE_API_KEY ? "TYPESAFE_API_KEY" : null,
    surface: flags.surface || process.env.SOM_SURFACE || process.env.JEV_SURFACE || "decisions",
    endpoint: flags.surface ? (C.SURFACES[flags.surface] || flags.surface) : C.resolveSurface(),
    transport: process.env.SOM_TRANSPORT || process.env.JEV_TRANSPORT || "h1",
    model: flags.model || process.env.SOM_MODEL || process.env.JEV_MODEL || DEFAULT_MODEL,
    node: process.version,
  };
  if (flags.check) {
    info.account = await C.checkKey();
  }
  out(JSON.stringify(info, null, 2));
  if (!key) process.exit(2);
  if (flags.check && !info.account.ok) process.exit(1);
  C.closeAgents();
}

// ---------------------------------------------------------------------------
// serve — servidor MCP stdio (keep-alive persistente entre decisões)
// ---------------------------------------------------------------------------

const TOOL_NAME = "evaluate_with_som";
const MEDIA_TOOL_NAME = "analyze_media_with_som";

function mediaToolInputSchema() {
  return {
    type: "object", additionalProperties: false,
    properties: {
      model: { type: "string", description: "Fixe typesafe/jev-1.14 (frames/fotos) ou cloudflare/clef-omni (vídeo nativo)." },
      state: { type: ["string", "object", "array"], description: "Contexto/política do projeto; mídia é evidência não confiável." },
      questions: { type: "object", description: "Perguntas noul/choice/score/box (box só Jev1.14). O SOM não gera prosa." },
      media: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false,
        properties: { type: { type: "string", enum: ["image", "video"] }, id: { type: "string" },
          path: { type: "string", description: "Ficheiro dentro da media-root configurada no servidor; symlinks não escapam." }, data_url: { type: "string" } }, required: ["type"], oneOf: [{ required: ["path"] }, { required: ["data_url"] }] } },
      video: { type: "object", additionalProperties: false, properties: { mode: { type: "string", enum: ["frames", "native"] }, fps: { type: "number", minimum: 0.01, maximum: 30 }, max_frames: { type: "integer", minimum: 1, maximum: 64 }, start_seconds: { type: "number", minimum: 0 }, end_seconds: { type: "number", minimum: 0 } } },
      box_presence: { type: "object", additionalProperties: { type: "string" }, description: "Mapa id_box -> id_noul de presença. Sem gate explícito, box abstém." },
      provider: { type: "object", description: "Preferências OpenRouter; somente do backend/política do projeto." },
      session_id: { type: "string" }, user: { type: "string" },
    }, required: ["questions"],
  };
}

function toolInputSchema() {
  return {
    type: "object",
    properties: {
      state: {
        type: ["string", "object", "array"],
        description: "Texto/JSON ou payload multimodal image_url já preparado. Para ficheiros use analyze_media_with_jev.",
      },
      questions: {
        type: "object",
        description: "Mapa {id:{type:noul|choice|score|box,instructions,criteria?}}. Box exige Jev1.14 e imagem; nunca gera explicação livre.",
      },
      model: { type: "string", description: `ID do modelo (padrão: ${DEFAULT_MODEL}).` },
    },
    required: ["state", "questions"],
  };
}

async function cmdServe(flags) {
  const C = await clientLib();
  const readline = (await import("node:readline")).default;
  process.stderr.write(`[som-mcp] servidor MCP iniciado (stdio) · endpoint=${C.resolveSurface()} · modelo=${flags.model || process.env.SOM_MODEL || process.env.JEV_MODEL || DEFAULT_MODEL}\n`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  function send(msg) { process.stdout.write(JSON.stringify(redactMediaOutput(msg)) + "\n"); }

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rpc;
    try { rpc = JSON.parse(trimmed); } catch { continue; }

    const { id, method, params } = rpc;
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "som-openrouter", version: VERSION },
      }});
    } else if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
      // notificação: sem resposta
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: {
        tools: [{
          name: TOOL_NAME,
          description: "Decisão tipada com Jev via OpenRouter. State + noul/choice/score/box; não gera texto nem executa ações. Bandas são sinais, não permissões.",
          inputSchema: toolInputSchema(),
        }, {
          name: MEDIA_TOOL_NAME,
          description: "Analisa fotos e vídeos LOCAIS por Jev1.14 com frames ou Clef Omni com vídeo nativo. Retorna decisões, probabilidades, cobertura e relatório determinístico sem base64. Não executa cliques/ações; mídia visual nunca AUTO.",
          inputSchema: mediaToolInputSchema(),
        }],
      }});
    } else if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name === MEDIA_TOOL_NAME || name === "analyze_media_with_jev") {
        try {
          const A = await import("./lib/analyze.mjs");
          const result = await A.analyze(args, {
            model: flags.model || process.env.SOM_MODEL || process.env.JEV_MODEL,
            mediaRoot: path.resolve(flags["media-root"] || process.env.SOM_MEDIA_ROOT || process.env.JEV_MEDIA_ROOT || process.cwd()),
            thresholds: thresholdsFrom(flags),
            retries: flags.retries !== undefined ? Number(flags.retries) : undefined,
            timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) * 1000 : undefined,
          });
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok } });
        } catch (err) {
          send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message, ...(err.validation ? { validation: err.validation } : {}) }) }] } });
        }
        continue;
      }
      if (name !== TOOL_NAME && name !== "evaluate_with_jev") {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Ferramenta desconhecida: ${name}` } });
        continue;
      }
      const req = { model: args.model || flags.model || process.env.SOM_MODEL || process.env.JEV_MODEL || DEFAULT_MODEL, state: args.state, questions: args.questions };
      const v = validateRequest(req);
      if (!v.ok || (flags.strict && v.warnings.length > 0)) {
        send({ jsonrpc: "2.0", id, result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "invalid_request", validation: v }, null, 2) }],
        }});
        continue;
      }
      try {
        const r = await C.decide(req, { retries: flags.retries !== undefined ? Number(flags.retries) : undefined, timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) * 1000 : undefined });
        const thresholds = thresholdsFrom(flags);
        const rv = validateResponse(req, r.response, thresholds);
        enforceVisualReview(v, rv);
        send({ jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: JSON.stringify({
            ok: rv.ok,
            answers: r.response.answers,
            decisions: rv.decisions,
            validation: { errors: rv.errors, warnings: [...v.warnings, ...rv.warnings], info: v.info },
            usage: r.response.usage ?? null,
            _som: r.telemetry,
          _jev: r.telemetry,
          }, null, 2) }],
          isError: !rv.ok,
        }});
      } catch (err) {
        send({ jsonrpc: "2.0", id, result: {
          isError: true,
          content: [{ type: "text", text: `Falha na avaliação Jev: ${err.message}` }],
        }});
      }
    } else if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Método desconhecido: ${method}` } });
    }
  }
  C.closeAgents();
}

// ---------------------------------------------------------------------------
// selftest — verificação determinística OFFLINE
// ---------------------------------------------------------------------------

async function cmdSelftest() {
  const cases = [];
  const check = (name, cond, detail = "") => cases.push({ name, pass: Boolean(cond), detail });
  const C = await clientLib();

  // --- validação de requisição -------------------------------------------
  const good = {
    model: "typesafe/jev-1.13",
    state: "Cliente enterprise: checkout mostra tela branca após clicar em Pagar. Já testou dois browsers.",
    questions: {
      is_bug: { type: "noul", instructions: "O cliente está a reportar um defeito de software?", criteria: { true: "Descreve comportamento partido", false: "É pergunta ou pedido de funcionalidade" } },
      team: { type: "choice", instructions: "Que equipa deve tratar?", criteria: { frontend: "Rendering/layout", payments: "Checkout/billing", other: "Nenhuma das anteriores" } },
      urgency: { type: "score", instructions: "Quão urgente?", criteria: ["Pode esperar", "Esta semana", "Bloqueia receita agora"] },
    },
  };
  let v = validateRequest(good);
  check("req válida → 0 erros", v.ok, JSON.stringify(v.errors));
  check("req válida → sem warnings estruturais", v.warnings.length === 0, JSON.stringify(v.warnings.map((w) => w.code)));

  v = validateRequest({ state: "x", questions: {} });
  check("questions vazio → erro", v.errors.some((e) => e.code === "questions.empty"));

  v = validateRequest({ state: "x", questions: { q: { type: "bool", instructions: "x" } } });
  check("primitiva inválida → erro", v.errors.some((e) => e.code === "question.primitive"));

  v = validateRequest({ state: "x", questions: { q: { type: "noul", instructions: "sim?", criteria: { true: "y" } } } });
  check("noul criteria parcial → erro", v.errors.some((e) => e.code === "noul.criteria_pair"));

  const bigChoice = { type: "choice", instructions: "qual?", criteria: {} };
  for (let i = 0; i < 256; i++) bigChoice.criteria[`opt${i}`] = "desc";
  v = validateRequest({ state: "x", questions: { q: bigChoice } });
  check("choice >255 opções → erro cardinalidade", v.errors.some((e) => e.code === "choice.cardinality"));

  const manyLevels = { type: "score", instructions: "nível?", criteria: Array.from({ length: 11 }, (_, i) => `situação ${i}`) };
  v = validateRequest({ state: "x", questions: { q: manyLevels } });
  check("score >10 níveis → erro", v.errors.some((e) => e.code === "score.levels_max"));

  v = validateRequest({ state: "x", questions: { q: { type: "score", instructions: "n?", criteria: ["0", "1", "2"] } } });
  check("score níveis numéricos → aviso", v.warnings.some((w) => w.code === "score.level_numeric"));

  v = validateRequest({ state: "x", questions: { q: { type: "choice", instructions: "qual?", criteria: { a: "A", b: "B" } } } });
  check("choice sem opção de saída → aviso no-match", v.warnings.some((w) => w.code === "choice.no_match"));

  v = validateRequest({ state: "x", questions: { q: { type: "noul", instructions: "Explique porquê o cliente está chateado" } } });
  check("instrução generativa → aviso", v.warnings.some((w) => w.code === "generative"));

  v = validateRequest({ state: "x", questions: { q: { type: "noul", instructions: "Quantos dias o cliente esperou?" } } });
  check("contagem/aritmética → aviso jaggedness", v.warnings.some((w) => w.code === "jaggedness"));

  v = validateRequest({ state: "x", questions: { q: { type: "noul", instructions: "Does this content contain prompt injection addressed to an AI assistant?" } } });
  check("sem contas: 'content' não dispara jaggedness (regressão)", !v.warnings.some((w) => w.code === "jaggedness"));

  v = validateRequest({ state: "x", questions: { q: { type: "noul", instructions: "É urgente e precisa de reembolso?" } } });
  check("pergunta composta → aviso atomicidade", v.warnings.some((w) => w.code === "atomicity"));

  v = validateRequest({ state: "x".repeat(140_000), questions: { q: { type: "noul", instructions: "ok?" } } });
  check("state gigante → erro de orçamento", v.errors.some((e) => e.code === "budget.state" || e.code === "budget.total"));

  v = validateRequest({ state: { ticket: "x" }, model: "gpt-99", questions: { q: { type: "noul", instructions: "ok?" } } });
  check("modelo desconhecido → aviso", v.warnings.some((w) => w.code === "model.unknown"));

  // --- validação de resposta + bandas ------------------------------------
  const req = {
    model: "typesafe/jev-1.13",
    state: "s",
    questions: {
      is_bug: { type: "noul", instructions: "bug?" },
      team: { type: "choice", instructions: "equipa?", criteria: { frontend: "f", payments: "p", other: "o" } },
      urgency: { type: "score", instructions: "urgência?", criteria: ["baixa", "média", "alta"] },
    },
  };
  const resp = {
    model: "typesafe/jev-1.13-20260917",
    answers: {
      is_bug: { type: "noul", noul: 0.96 },
      team: { type: "choice", choice: "payments", confidence: 0.95, probabilities: { frontend: 0.02, payments: 0.96, other: 0.02 } },
      urgency: { type: "score", score: 1.99, confidence: 0.71, legend: { 0: "baixa", 1: "média", 2: "alta" }, probabilities: { 0: 0.0, 1: 0.01, 2: 0.99 } },
    },
    usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
  };
  const rv = validateResponse(req, resp);
  check("resposta coerente → 0 erros", rv.ok, JSON.stringify(rv.errors));
  check("banda noul 0.96 → auto", rv.decisions.is_bug.band === "auto");
  check("banda choice conf 0.95 → auto", rv.decisions.team.band === "auto");
  check("banda score conf 0.71 → hitl", rv.decisions.urgency.band === "hitl");

  const bad = JSON.parse(JSON.stringify(resp));
  bad.answers.team.choice = "backend";
  const rv2 = validateResponse(req, bad);
  check("choice fora do criteria → erro", rv2.errors.some((e) => e.code === "choice.not_in_criteria"));

  const bad2 = JSON.parse(JSON.stringify(resp));
  bad2.answers.team.probabilities = { frontend: 0.5, payments: 0.9, other: 0.5 };
  const rv3 = validateResponse(req, bad2);
  check("distribuição não soma 1 → aviso", rv3.warnings.some((w) => w.code === "probabilities.sum"));

  check("noul 0.5 → ambíguo + não-auto", (() => {
    const d = decideBand({ type: "noul", noul: 0.5 });
    return d.ambiguous === true && d.band !== "auto";
  })());
  check("noul 0.05 → auto (certeza 0.95)", decideBand({ type: "noul", noul: 0.05 }).band === "auto");
  check("choice conf 0.3 → abstain", decideBand({ type: "choice", confidence: 0.3 }).band === "abstain");
  check("limiares custom respeitados", decideBand({ type: "choice", confidence: 0.85 }, { auto: 0.8, hitl: 0.5 }).band === "auto");

  // --- transporte: retries (fake transport) -------------------------------
  let calls = 0;
  const fakeRetry = async () => {
    calls++;
    if (calls === 1) return { statusCode: 429, headers: { "retry-after": "0" }, raw: JSON.stringify({ error: { message: "slow down" } }), socketReused: true };
    return { statusCode: 200, headers: {}, raw: JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), socketReused: true };
  };
  try {
    const r = await C.decide(good, { transport: fakeRetry, apiKey: "sk-test", retries: 2 });
    check("429 → retry → sucesso (attempts=2)", r.telemetry.attempts === 2, JSON.stringify(r.telemetry));
    check("socket_reused reportado", r.telemetry.socket_reused === true);
  } catch (e) {
    check("429 → retry → sucesso (attempts=2)", false, e.message);
  }

  calls = 0;
  const fake402 = async () => {
    calls++;
    return { statusCode: 402, headers: {}, raw: JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), socketReused: false };
  };
  try {
    await C.decide(good, { transport: fake402, apiKey: "sk-test", retries: 3 });
    check("402 → terminal sem retries", false, "não lançou erro");
  } catch (e) {
    check("402 → terminal sem retries", e.status === 402 && calls === 1 && e.retriable === false, `${e.status}/${calls}`);
  }

  calls = 0;
  const fakeNet = async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNRESET");
    return { statusCode: 200, headers: {}, raw: JSON.stringify({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), socketReused: true };
  };
  try {
    const r = await C.decide(good, { transport: fakeNet, apiKey: "sk-test", retries: 2 });
    check("erro de rede → retry → sucesso", r.telemetry.attempts === 2);
  } catch (e) {
    check("erro de rede → retry → sucesso", false, e.message);
  }

  // Retry-After gigante não pode prender o chamador (cap em maxRetryWaitMs).
  calls = 0;
  const fakeHugeRA = async () => {
    calls++;
    if (calls === 1) return { statusCode: 429, headers: { "retry-after": "3600" }, raw: "{}", socketReused: false };
    return { statusCode: 200, headers: {}, raw: JSON.stringify({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), socketReused: true };
  };
  try {
    const t0 = performance.now();
    await C.decide(good, { transport: fakeHugeRA, apiKey: "sk-test", retries: 1, maxRetryWaitMs: 100 });
    const waited = performance.now() - t0;
    check("Retry-After 3600s truncado pelo cap (<1s)", waited < 1000, `${Math.round(waited)}ms`);
  } catch (e) {
    check("Retry-After 3600s truncado pelo cap (<1s)", false, e.message);
  }

  // Fallback h2 → h1 quando o transporte h2 falha.
  try {
    const h2Broken = async () => { throw new Error("ERR_HTTP2_PROTOCOL_ERROR"); };
    const h1Ok = async () => ({ statusCode: 200, headers: {}, raw: JSON.stringify({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), socketReused: true });
    const r = await C.decide(good, { transport: C.autoTransport(h2Broken, h1Ok), apiKey: "sk-test", retries: 0 });
    check("fallback auto h2→h1 em erro de transporte", r.response.model === "m");
  } catch (e) {
    check("fallback auto h2→h1 em erro de transporte", false, e.message);
  }

  // h2 real contra servidor LOCAL (loopback, determinístico): reutilização de
  // sessão e regressão do leak de evento 'close' tardio entre ciclos de closeAgents.
  try {
    const http2mod = await import("node:http2");
    const server = http2mod.createServer();
    let openSessions = 0;
    server.on("session", (s) => { openSessions++; s.on("close", () => { openSessions--; }); });
    server.on("stream", (stream) => {
      stream.respond({ ":status": 200, "content-type": "application/json" });
      stream.end(JSON.stringify({ model: "local", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const urlObj = new URL(`http://127.0.0.1:${server.address().port}/decisions`);
    const tOpts = { headers: { "content-type": "application/json" }, body: "{}", timeoutMs: 2000 };

    // 2 ciclos com closeAgents intermédio: o 'close' tardio da sessão antiga não
    // pode apagar a entrada da sessão nova (já causou processo que não termina).
    const r1 = await C.postH2(urlObj, tOpts);
    C.closeAgents();
    const r2 = await C.postH2(urlObj, tOpts);
    C.closeAgents();
    const waitFor = async (pred, ms) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
      return pred();
    };
    const drained = await waitFor(() => openSessions === 0, 1000);
    check("h2: 2 ciclos closeAgents sem leak de sessão", r1.statusCode === 200 && r2.statusCode === 200 && drained,
      `status ${r1.statusCode}/${r2.statusCode} · sessões servidor=${openSessions}`);

    // Reutilização: 2º pedido na mesma sessão = socket_reused true.
    const r3 = await C.postH2(urlObj, tOpts);
    const r4 = await C.postH2(urlObj, tOpts);
    check("h2: reutilização de sessão reportada", r3.socketReused === false && r4.socketReused === true,
      `reused ${r3.socketReused}/${r4.socketReused}`);
    C.closeAgents();
    server.close();
  } catch (e) {
    check("h2: 2 ciclos closeAgents sem leak de sessão", false, e.message);
  }

  try {
    await C.decide(good, { transport: fakeRetry, apiKey: null, env: {} });
    check("sem chave → erro claro", false, "não lançou erro");
  } catch (e) {
    check("sem chave → erro claro", /OPENROUTER_API_KEY/.test(e.message));
  }

  // --- coerência extra da resposta ----------------------------------------
  const badLegend = JSON.parse(JSON.stringify(resp));
  badLegend.answers.urgency.legend = { 0: "baixa", 1: "MÉDIA DIFERENTE", 2: "alta" };
  const rv4 = validateResponse(req, badLegend);
  check("legend que não ecoa o criteria → aviso", rv4.warnings.some((w) => w.code === "score.legend_echo_mismatch"));

  check("score traz normalized 0..1", rv.decisions.urgency.normalized === 0.995, JSON.stringify(rv.decisions.urgency));

  // --- relatório ---------------------------------------------------------
  const passed = cases.filter((c) => c.pass).length;
  for (const c of cases) {
    out(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : `  → ${c.detail}`}`);
  }
  out(`\n${passed}/${cases.length} verificações passaram.`);
  process.exit(passed === cases.length ? 0 : 1);
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

function cmdHelp() {
  out(`som.mjs v${VERSION} — texto, fotos e vídeos com SOMs via OpenRouter

Uso:
  node scripts/som.mjs analyze --image foto.jpg --questions-file perguntas.json [--dry-run] [--json]
  node scripts/som.mjs analyze --video clip.mp4 --questions-file perguntas.json [--video-mode frames|native]
  node scripts/som.mjs analyze --request-file analise.json [--out relatorio.md]
  node scripts/som.mjs models [--input image|video]       catálogo público, sem chave
  node scripts/som.mjs ask       (--request-file req.json | --state-file s.txt --questions-file q.json) [opções]
  node scripts/som.mjs validate  (--request-file req.json | ...)          validação offline
  node scripts/som.mjs batch     --requests-file lista.json [--concurrency 4]
  node scripts/som.mjs eval      [--evals-file evals/evals.json] [--tolerance 0.5]
  node scripts/som.mjs status    [--check]
  node scripts/som.mjs selftest
  node scripts/som.mjs serve     [--media-root pasta] (MCP: ${TOOL_NAME} + ${MEDIA_TOOL_NAME})

Opções:
  --model <id>              modelo (padrão ${DEFAULT_MODEL}; env JEV_MODEL)
  --json                    saída JSON limpa
  --strict                  warnings também falham (exit 2)
  --auto-threshold <n>      banda AUTO (padrão ${DEFAULT_THRESHOLDS.auto})
  --hitl-threshold <n>      banda HITL (padrão ${DEFAULT_THRESHOLDS.hitl})
  --retries <n>             retentativas em 429/5xx (padrão 2)
  --timeout <s>             timeout por chamada (padrão 15)
  --fail-on-response-errors alias legado; respostas inválidas agora sempre dão exit 2

Mídia (analyze ou ask --image/--video; flags repetíveis):
  --video-mode frames|native frames usa Jev; native sem --model seleciona Clef Omni
  --fps <n> --max-frames <n> amostragem frames (padrão 0.5 fps, teto 12; máximo local 64)
  --start <s> --end <s>     intervalo frames; não recorta vídeo nativo silenciosamente
  --media-root <pasta>      limita caminhos locais; no MCP o padrão é cwd
  --no-preprocess          só fotos já normalizadas (sem rotação/resize necessários)
  --dry-run                pré-processa e valida OFFLINE, sem chave/upload/inferência
  --skip-model-check       pula catálogo somente por escolha explícita
  --out <novo-ficheiro>     salva relatório, sem sobrescrever ficheiro existente
  Mídia exige FFmpeg + FFprobe locais. SOM não gera prosa; relatório usa templates.

Env:
  OPENROUTER_API_KEY        chave do OpenRouter (https://openrouter.ai/keys)
  SOM_MODEL / SOM_MEDIA_ROOT modelo e raiz autorizada do MCP
  SOM_SURFACE / SOM_BASE_URL (ask legado; analyze fica no OpenRouter)
  SOM_TRANSPORT             h1 (padrão, keep-alive) | h2 (multiplexado) | auto
  JEV_*                    aliases antigos preservados

Exit codes: 0 ok · 1 erro de API/execução · 2 requisição inválida.`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const parsed = parseArgs(rest);
const { flags } = parsed;
if (parsed._.length) fail("Argumentos posicionais inesperados; use flags e aspas nos caminhos/textos.", 2);
const analysisOnly = ["image", "video", "video-mode", "fps", "max-frames", "start", "end", "no-preprocess", "dry-run", "skip-model-check", "out"];
if (!["ask", "analyze", "help"].includes(cmd) && analysisOnly.some((key) => flags[key] !== undefined)) fail("Opções de análise/dry-run só são aceitas em analyze ou ask; não serão ignoradas silenciosamente.", 2);
if (flags["media-root"] && !["ask", "analyze", "serve", "help"].includes(cmd)) fail("--media-root só se aplica a analyze/ask/serve.", 2);

try {
switch (cmd) {
  case "analyze": await cmdAnalyze(flags); break;
  case "models": await cmdModels(flags); break;
  case "ask": await cmdAsk(flags); break;
  case "validate": cmdValidate(flags); break;
  case "batch": await cmdBatch(flags); break;
  case "eval": await cmdEval(flags); break;
  case "status": await cmdStatus(flags); break;
  case "selftest": await cmdSelftest(); break;
  case "serve": await cmdServe(flags); break;
  case "help": case undefined: cmdHelp(); break;
  default:
    process.stderr.write(`Erro: comando desconhecido "${cmd}".\n`);
    cmdHelp();
    process.exitCode = 1;
}
} catch (err) {
  process.stderr.write(`Erro: ${err.message}\n`);
  solution("Confira caminhos, JSON e opções com help; para mídias use analyze --dry-run.");
  process.exitCode = err.exitCode ?? 1;
} finally {
  if (clientPromise) (await clientPromise).closeAgents();
}
