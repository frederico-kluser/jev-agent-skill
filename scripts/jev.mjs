#!/usr/bin/env node
// jev.mjs — CLI de decisão rápida com o modelo Jev (System One) via OpenRouter.
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
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  validateRequest, validateResponse, decideBand, DEFAULT_THRESHOLDS, LIMITS,
} from "./lib/validate.mjs";
import {
  decide, checkKey, closeAgents, resolveApiKey, resolveSurface, SURFACES, DEFAULT_MODEL,
  JevClientError,
} from "./lib/client.mjs";

const VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Helpers de CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readJsonFile(p) {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, "utf8");
  try {
    return JSON.parse(raw);
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

function out(text) { process.stdout.write(text + "\n"); }

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
    return readJsonFile(flags["request-file"]);
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
  req.model = flags.model || process.env.JEV_MODEL || DEFAULT_MODEL;
  return req;
}

function thresholdsFrom(flags) {
  return {
    auto: flags["auto-threshold"] !== undefined ? Number(flags["auto-threshold"]) : DEFAULT_THRESHOLDS.auto,
    hitl: flags["hitl-threshold"] !== undefined ? Number(flags["hitl-threshold"]) : DEFAULT_THRESHOLDS.hitl,
  };
}

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------

async function cmdAsk(flags) {
  const req = loadRequest(flags);
  const thresholds = thresholdsFrom(flags);

  const v = validateRequest(req);
  if (!v.ok || (flags.strict && v.warnings.length > 0)) {
    if (flags.json) out(JSON.stringify({ ok: false, validation: v }, null, 2));
    else {
      out(`Requisição INVÁLIDA (${v.errors.length} erro(s), ${v.warnings.length} aviso(s)):`);
      out(formatReport(v));
    }
    if (!v.ok) { process.exit(2); }
  }

  let result;
  try {
    result = await decide(req, {
      retries: flags.retries !== undefined ? Number(flags.retries) : undefined,
      timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) * 1000 : undefined,
    });
  } catch (err) {
    const isApi = err instanceof JevClientError;
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

  if (flags.json) {
    out(JSON.stringify(payload, null, 2));
  } else {
    out(`# Decisão Jev (${payload._jev.latency_ms} ms · socket ${payload._jev.socket_reused ? "QUENTE ✓" : "frio (1ª chamada)"})`);
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
  if (!rv.ok && flags["fail-on-response-errors"]) process.exit(2);
  closeAgents();
}

// ---------------------------------------------------------------------------
// validate (offline)
// ---------------------------------------------------------------------------

function cmdValidate(flags) {
  const req = loadRequest(flags);
  const v = validateRequest(req);
  if (flags.json) {
    out(JSON.stringify({ ...v, budget_limits: { total: LIMITS.REQUEST_TOTAL_TOKENS, state_plus_longest_q: LIMITS.STATE_PLUS_LONGEST_Q_TOKENS } }, null, 2));
  } else {
    out(`Requisição ${v.ok ? "VÁLIDA" : "INVÁLIDA"} — ${v.errors.length} erro(s), ${v.warnings.length} aviso(s), ${v.info.length} nota(s).`);
    out(`Orçamento estimado: state=${v.budget.state_tokens} tok · perguntas=${v.budget.questions_tokens} tok · total=${v.budget.total_tokens} tok (limite ${LIMITS.REQUEST_TOTAL_TOKENS}; state+pergunta mais longa=${v.budget.state_tokens + v.budget.longest_question_tokens}/${LIMITS.STATE_PLUS_LONGEST_Q_TOKENS})`);
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
  const concurrency = Math.max(1, Number(flags.concurrency || 4));
  const results = new Array(items.length);

  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const req = { model: flags.model || process.env.JEV_MODEL || DEFAULT_MODEL, ...items[i] };
      const v = validateRequest(req);
      if (!v.ok) {
        results[i] = { index: i, ok: false, validation: v };
        continue;
      }
      try {
        const r = await decide(req, { retries: flags.retries !== undefined ? Number(flags.retries) : undefined });
        const rv = validateResponse(req, r.response, thresholds);
        results[i] = {
          index: i, ok: rv.ok,
          answers: r.response.answers,
          decisions: rv.decisions,
          validation: { errors: rv.errors, warnings: [...v.warnings, ...rv.warnings] },
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
  closeAgents();
}

// ---------------------------------------------------------------------------
// eval — calibração (accuracy, confiança média, ECE) sobre casos rotulados
// ---------------------------------------------------------------------------

async function cmdEval(flags) {
  const cases = readJsonFile(flags["evals-file"] || "evals/evals.json");
  if (!Array.isArray(cases)) fail("O ficheiro de evals deve ser um array de casos { name, state, questions, expected }.");
  const thresholds = thresholdsFrom(flags);

  const rows = [];
  for (const c of cases) {
    const req = { model: flags.model || process.env.JEV_MODEL || DEFAULT_MODEL, state: c.state, questions: c.questions };
    const v = validateRequest(req);
    if (!v.ok) { rows.push({ name: c.name, skipped: true, reason: "invalid_request", errors: v.errors }); continue; }
    let resp;
    try {
      const r = await decide(req, {});
      resp = r.response;
    } catch (err) {
      rows.push({ name: c.name, skipped: true, reason: err.message });
      continue;
    }
    const rv = validateResponse(req, resp, thresholds);
    for (const [qid, expected] of Object.entries(c.expected || {})) {
      const a = resp.answers[qid];
      if (!a) { rows.push({ name: c.name, qid, skipped: true, reason: "no_answer" }); continue; }
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

  const scored = rows.filter((r) => r.correct !== undefined);
  const n = scored.length;
  const accuracy = n ? scored.filter((r) => r.correct).length / n : null;
  const meanConf = n ? scored.reduce((a, r) => a + r.confidence, 0) / n : null;

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
    calibration_bins: binReport,
    rows,
  };
  out(JSON.stringify(report, null, 2));
  closeAgents();
}

function round3(x) { return Math.round(x * 1e3) / 1e3; }

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus(flags) {
  const key = resolveApiKey();
  const info = {
    key: key ? `${key.slice(0, 6)}…${key.slice(-4)} (mascarada)` : "AUSENTE",
    key_source: process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY" : process.env.JEV_API_KEY ? "JEV_API_KEY" : process.env.TYPESAFE_API_KEY ? "TYPESAFE_API_KEY" : null,
    surface: flags.surface || process.env.JEV_SURFACE || "decisions",
    endpoint: flags.surface ? (SURFACES[flags.surface] || flags.surface) : resolveSurface(),
    model: flags.model || process.env.JEV_MODEL || DEFAULT_MODEL,
    node: process.version,
  };
  if (flags.check) {
    info.account = await checkKey();
  }
  out(JSON.stringify(info, null, 2));
  if (!key) process.exit(2);
  if (flags.check && !info.account.ok) process.exit(1);
  closeAgents();
}

// ---------------------------------------------------------------------------
// serve — servidor MCP stdio (keep-alive persistente entre decisões)
// ---------------------------------------------------------------------------

const TOOL_NAME = "evaluate_with_jev";

function toolInputSchema() {
  return {
    type: "object",
    properties: {
      state: {
        type: ["string", "object", "array"],
        description: "O conteúdo a avaliar: texto, ou objeto/array JSON de contexto. Só texto é aceite pelo modelo.",
      },
      questions: {
        type: "object",
        description: "Mapa { id: { type: 'noul'|'choice'|'score', instructions, criteria? } }. Várias perguntas são avaliadas em paralelo sobre o mesmo state.",
      },
      model: { type: "string", description: `ID do modelo (padrão: ${DEFAULT_MODEL}).` },
    },
    required: ["state", "questions"],
  };
}

async function cmdServe(flags) {
  process.stderr.write(`[jev-mcp] servidor MCP iniciado (stdio) · endpoint=${resolveSurface()} · modelo=${flags.model || process.env.JEV_MODEL || DEFAULT_MODEL}\n`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

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
        serverInfo: { name: "jev-fast-decision", version: VERSION },
      }});
    } else if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
      // notificação: sem resposta
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: {
        tools: [{
          name: TOOL_NAME,
          description: "Decisão tipada hiper-rápida com o modelo Jev (System One) via OpenRouter. Envia state + perguntas tipadas (noul/choice/score) e devolve decisões com probabilidades calibradas + banda de ação (auto/hitl/abstain). Não gera texto.",
          inputSchema: toolInputSchema(),
        }],
      }});
    } else if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name !== TOOL_NAME) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Ferramenta desconhecida: ${name}` } });
        continue;
      }
      const req = { model: args.model || flags.model || process.env.JEV_MODEL || DEFAULT_MODEL, state: args.state, questions: args.questions };
      const v = validateRequest(req);
      if (!v.ok) {
        send({ jsonrpc: "2.0", id, result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "invalid_request", validation: v }, null, 2) }],
        }});
        continue;
      }
      try {
        const r = await decide(req, { retries: flags.retries !== undefined ? Number(flags.retries) : undefined });
        const thresholds = thresholdsFrom(flags);
        const rv = validateResponse(req, r.response, thresholds);
        send({ jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: JSON.stringify({
            ok: rv.ok,
            answers: r.response.answers,
            decisions: rv.decisions,
            validation: { errors: rv.errors, warnings: [...v.warnings, ...rv.warnings], info: v.info },
            usage: r.response.usage ?? null,
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
  closeAgents();
}

// ---------------------------------------------------------------------------
// selftest — verificação determinística OFFLINE
// ---------------------------------------------------------------------------

async function cmdSelftest() {
  const cases = [];
  const check = (name, cond, detail = "") => cases.push({ name, pass: Boolean(cond), detail });

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
    const r = await decide(good, { transport: fakeRetry, apiKey: "sk-test", retries: 2 });
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
    await decide(good, { transport: fake402, apiKey: "sk-test", retries: 3 });
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
    const r = await decide(good, { transport: fakeNet, apiKey: "sk-test", retries: 2 });
    check("erro de rede → retry → sucesso", r.telemetry.attempts === 2);
  } catch (e) {
    check("erro de rede → retry → sucesso", false, e.message);
  }

  try {
    await decide(good, { transport: fakeRetry, apiKey: null, env: {} });
    check("sem chave → erro claro", false, "não lançou erro");
  } catch (e) {
    check("sem chave → erro claro", /OPENROUTER_API_KEY/.test(e.message));
  }

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
  out(`jev.mjs v${VERSION} — decisões tipadas rápidas com o Jev (System One) via OpenRouter

Uso:
  node scripts/jev.mjs ask       (--request-file req.json | --state-file s.txt --questions-file q.json) [opções]
  node scripts/jev.mjs validate  (--request-file req.json | ...)          validação offline
  node scripts/jev.mjs batch     --requests-file lista.json [--concurrency 4]
  node scripts/jev.mjs eval      [--evals-file evals/evals.json] [--tolerance 0.5]
  node scripts/jev.mjs status    [--check]
  node scripts/jev.mjs selftest
  node scripts/jev.mjs serve     (servidor MCP stdio: ferramenta ${TOOL_NAME})

Opções:
  --model <id>              modelo (padrão ${DEFAULT_MODEL}; env JEV_MODEL)
  --json                    saída JSON limpa
  --strict                  warnings também falham (exit 2)
  --auto-threshold <n>      banda AUTO (padrão ${DEFAULT_THRESHOLDS.auto})
  --hitl-threshold <n>      banda HITL (padrão ${DEFAULT_THRESHOLDS.hitl})
  --retries <n>             retentativas em 429/5xx (padrão 2)
  --timeout <s>             timeout por chamada (padrão 15)
  --fail-on-response-errors exit 2 se a resposta tiver erros de coerência

Env:
  OPENROUTER_API_KEY        chave do OpenRouter (https://openrouter.ai/keys)
  JEV_MODEL / JEV_SURFACE (decisions|systemone|typesafe) / JEV_BASE_URL

Exit codes: 0 ok · 1 erro de API/execução · 2 requisição inválida.`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const { flags } = parseArgs(rest);

switch (cmd) {
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
    process.exit(1);
}
