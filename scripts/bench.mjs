#!/usr/bin/env node
// bench.mjs — benchmark de desempenho da skill (offline por omissão).
//
//   node scripts/bench.mjs            arranque + validação + selftest
//   node scripts/bench.mjs --live     + latência real h1 vs h2 (gasta ~40 chamadas)
//   node scripts/bench.mjs --out resultados.json
//
// Mede o que importa para a promessa "decisão o mais rápido possível":
//   1. cli_startup_ms        — imposto fixo por comando efémero
//   2. validate_ops_per_sec  — custo da validação pesada (deve ser desprezável)
//   3. selftest_ms           — duração da verificação offline
//   4. live: warm_sequential — latência quente h1 vs h2 (o caminho comum)
//   5. live: parallel_burst  — rajada N-way: h1 (N sockets) vs h2 (1 canal multiplexado)
//   6. live: eval_wall_ms    — tempo de parede do eval completo (paralelo)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateRequest, validateResponse } from "./lib/validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const outIdx = argv.indexOf("--out");
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const avg = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  return { avg, p50: Math.round(s[Math.floor(s.length / 2)]), min: Math.round(s[0]), max: Math.round(s[s.length - 1]) };
}

const report = { when: new Date().toISOString(), node: process.version, live };

// 1) arranque da CLI --------------------------------------------------------
{
  const t = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    execFileSync("node", [path.join(root, "scripts/jev.mjs"), "help"], { stdio: "ignore", cwd: root });
    t.push(performance.now() - t0);
  }
  report.cli_startup_ms = stats(t);
}

// 2) throughput da validação -------------------------------------------------
{
  const req = JSON.parse(fs.readFileSync(path.join(root, "examples/requests/ticket-triage.json"), "utf8"));
  const bigReq = { ...req, state: JSON.stringify(req).repeat(40) }; // ~40KB
  const bench = (fn, n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    return Math.round(n / ((performance.now() - t0) / 1000));
  };
  report.validate_ops_per_sec = {
    small_request: bench(() => validateRequest(req), 20_000),
    big_request_40kb: bench(() => validateRequest(bigReq), 2_000),
    response_validation: bench(() => validateResponse(req, {
      model: "typesafe/jev-1.13",
      answers: {
        is_bug: { type: "noul", noul: 0.9 },
        team: { type: "choice", choice: "payments", confidence: 0.9, probabilities: { frontend: 0.05, payments: 0.9, other: 0.05 } },
        urgency: { type: "score", score: 2, confidence: 1, legend: { 0: "Can wait for the next release", 1: "Should be fixed this week", 2: "Blocking revenue right now" }, probabilities: { 0: 0, 1: 0, 2: 1 } },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }), 20_000),
  };
}

// 3) selftest -----------------------------------------------------------------
{
  const t = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    execFileSync("node", [path.join(root, "scripts/jev.mjs"), "selftest"], { stdio: "ignore", cwd: root });
    t.push(performance.now() - t0);
  }
  report.selftest_ms = stats(t);
}

// 4-6) rede real --------------------------------------------------------------
if (live) {
  const { decide, closeAgents } = await import("./lib/client.mjs");
  const sample = JSON.parse(fs.readFileSync(path.join(root, "examples/requests/ticket-triage.json"), "utf8"));
  const call = (mode) => decide(sample, { transportMode: mode, retries: 0 });

  // Rondas intercaladas h1/h2/auto: cada modo corre sob as MESMAS condições de
  // rede/servidor (bloco corrido seria confundido por variância temporal).
  const modes = ["h1", "h2", "auto"];
  for (const mode of modes) {
    closeAgents(); // warmup por modo: frio → estável (não medido)
    await call(mode); await call(mode);
    await Promise.all(Array.from({ length: 8 }, () => call(mode)));
  }
  const collected = Object.fromEntries(modes.map((m) => [m, { seq: [], burst: [] }]));
  for (let round = 0; round < 3; round++) {
    for (const mode of modes) {
      for (let i = 0; i < 4; i++) {
        const t0 = performance.now();
        await call(mode);
        collected[mode].seq.push(performance.now() - t0);
      }
      const t0 = performance.now();
      await Promise.all(Array.from({ length: 8 }, () => call(mode)));
      collected[mode].burst.push(performance.now() - t0);
    }
  }
  for (const mode of modes) {
    report[`live_${mode}`] = {
      warm_sequential_ms: stats(collected[mode].seq),
      parallel_burst_8x_ms: stats(collected[mode].burst),
    };
  }

  // eval completo (8 casos, concorrência 4)
  {
    const t0 = performance.now();
    execFileSync("node", [path.join(root, "scripts/jev.mjs"), "eval", "--evals-file", "evals/injection-evals.json"], { stdio: "ignore", cwd: root });
    report.eval_8cases_wall_ms = Math.round(performance.now() - t0);
  }
  closeAgents();
}

const json = JSON.stringify(report, null, 2);
out(json);
if (outPath) fs.writeFileSync(path.resolve(outPath), json + "\n");

function out(s) { process.stdout.write(s + "\n"); }
