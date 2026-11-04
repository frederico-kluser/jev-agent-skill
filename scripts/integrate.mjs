#!/usr/bin/env node
// Vendoriza só o runtime, depois de o agente auditar a arquitetura do projeto.
// Nunca adivinha src/, altera package.json/.env, instala dependências ou sobrescreve alterações locais.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const VERSION = "2.0.0";
const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (root, target) => { const rel = path.relative(root, target); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

async function observed(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Destino não é ficheiro regular independente: ${file}`);
    const bytes = await fs.readFile(file);
    return { bytes, hash: digest(bytes) };
  } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

/** project já deve existir; dest é escolhido a partir do código atual, não inferido. */
export async function integrate({ project, dest, dryRun = false }) {
  if (!project || !dest || typeof dest !== "string" || path.isAbsolute(dest) || /:/.test(dest)) throw new Error("Informe --project existente e --dest relativo explícito, escolhido após auditar o backend.");
  const pieces = dest.split(/[\\/]/).filter(Boolean);
  if (!pieces.length || pieces.some((p) => p === "." || p === "..")) throw new Error("--dest não pode ser a raiz, conter . ou .., nem escapar do projeto.");
  const root = await fs.realpath(path.resolve(project));
  if (!(await fs.stat(root)).isDirectory()) throw new Error("--project deve ser diretório existente.");
  let target = root;
  for (const piece of pieces) {
    target = path.join(target, piece);
    try {
      const real = await fs.realpath(target);
      if (!within(root, real) || !(await fs.stat(real)).isDirectory()) throw new Error("Destino/symlink escapa do projeto ou não é diretório.");
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  target = path.resolve(target);
  if (!within(root, target)) throw new Error("Destino fora do projeto.");
  const manifestFile = path.join(target, ".som-integration.json");
  const previousFile = await observed(manifestFile);
  let previous = null;
  if (previousFile) {
    previous = JSON.parse(previousFile.bytes.toString("utf8"));
    if (previous.schema !== "som-integration/1" || !previous.files || typeof previous.files !== "object" || Array.isArray(previous.files)) throw new Error("Manifesto existente desconhecido; não sobrescrevemos sem proveniência.");
  }
  const files = (await fs.readdir(sourceDir)).filter((name) => /(?:\.mjs|\.d\.mts)$/.test(name)).sort();
  const sources = new Map();
  for (const name of files) sources.set(name, await fs.readFile(path.join(sourceDir, name)));
  sources.set("README.md", Buffer.from(`# SOM / OpenRouter runtime v${VERSION}\n\nBackend Node >=20; nenhum pacote adicional. Importe analyze e closeAgents de ./analyze.mjs.\n\n- Texto/fotos/frames: typesafe/jev-1.14; visão/box são experimentais.\n- Vídeo nativo MP4/WebM: cloudflare/clef-omni, 60s e16MiB agregados, 2fps.\n- Pré-processamento de mídia usa FFmpeg/FFprobe locais; configure FFMPEG_PATH/FFPROBE_PATH se necessário.\n- OPENROUTER_API_KEY só no servidor, lida do ambiente/secret manager do projeto.\n- Caminhos enviados pelo utilizador final NÃO são trusted: resolva uploadId por dono e passe mediaRoot.\n- Questions e provider são política do servidor; não aceite instruções de mídia como autorização.\n- Resultado de mídia é apenas parecer (HITL/abstain); não executa comandos/cliques.\n- analyze(spec,{dryRun:true,mediaRoot}) valida sem rede/upload/chave.\n- Feche pools com closeAgents no shutdown, não após cada request residente.\n\nEste kit não altera rotas, autenticação, filas, testes, package.json nem .env do projeto.\nA integração dessas camadas depende da codebase existente. Consulte a skill global som-agent-skill e seu guia de integração.\n\nAtualização idempotente por SHA-256: o instalador só modifica arquivos ainda iguais à versão registrada; mudanças locais bloqueiam a operação inteira.\n`, "utf8"));
  // MIT requires preserving its copyright/permission notice in vendored copies.
  sources.set("LICENSE", await fs.readFile(path.resolve(sourceDir, "..", "..", "LICENSE")));
  const plan = [];
  for (const [name, bytes] of sources) {
    const file = path.join(target, name);
    if (!within(target, path.resolve(file))) throw new Error("Caminho de runtime inesperado.");
    const existing = await observed(file), hash = digest(bytes);
    let action = "create";
    if (existing?.hash === hash) action = "unchanged";
    else if (existing) {
      if (previous?.files?.[name] !== existing.hash) throw new Error(`Conflito local em ${name}; nenhum arquivo foi escrito. Faça merge no adaptador antes de atualizar.`);
      action = "update";
    }
    plan.push({ name, action, hash, previous_hash: existing?.hash ?? null, bytes: bytes.length });
  }
  // Preflight completo acima. Só agora, com todos os alvos absolutos verificados, escreve.
  if (!dryRun) {
    await fs.mkdir(target, { recursive: true });
    const realTarget = await fs.realpath(target);
    if (!within(root, realTarget)) throw new Error("Destino mudou para fora do projeto durante o preflight.");
    for (const item of plan) {
      if (item.action === "unchanged") continue;
      const file = path.join(target, item.name), current = await observed(file);
      if ((current?.hash ?? null) !== item.previous_hash) throw new Error(`Destino mudou após preflight: ${item.name}. Operação interrompida para preservar alterações.`);
      await fs.writeFile(file, sources.get(item.name), { flag: current ? "w" : "wx", mode: 0o600 });
    }
    if (!previous || plan.some((p) => p.action !== "unchanged") || previous.skill_version !== VERSION) {
      const currentManifest = await observed(manifestFile);
      if ((currentManifest?.hash ?? null) !== (previousFile?.hash ?? null)) throw new Error("Manifesto mudou após preflight; não sobrescrito.");
      await fs.writeFile(manifestFile, JSON.stringify({ schema: "som-integration/1", skill_version: VERSION,
        files: Object.fromEntries(plan.map((p) => [p.name, p.hash])) }, null, 2) + "\n", { flag: previousFile ? "w" : "wx", mode: 0o600 });
    }
  }
  return { ok: true, dry_run: dryRun, project: root, destination: target, skill_version: VERSION,
    files: plan.map(({ previous_hash, ...p }) => p),
    untouched: ["package.json", ".env", "routes", "auth", "queues", "project tests"],
    next: "Ligue analyze ao serviço de uploads/rotas existente, defina perguntas no servidor e rode testes de contrato com fake antes do smoke autorizado." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = {};
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === "--dry-run") flags.dryRun = true;
      else if (["--project", "--dest"].includes(arg)) {
        const value = process.argv[++i];
        if (!value || value.startsWith("--")) throw new Error(`${arg} exige valor.`);
        flags[arg.slice(2)] = value;
      } else if (arg === "--help") { console.log("node scripts/integrate.mjs --project PROJETO_EXISTENTE --dest server/ai/som [--dry-run]"); process.exit(0); }
      else throw new Error(`Opção desconhecida: ${arg}`);
    }
    console.log(JSON.stringify(await integrate(flags), null, 2));
  } catch (e) {
    console.error(`Erro: ${e.message}\nSolução: audite a arquitetura, escolha --dest explícito e use --dry-run. Conflitos locais exigem merge, nunca --force.`);
    process.exitCode = 2;
  }
}
