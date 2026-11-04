// Perfis de ADAPTADOR, não um catálogo eterno. Fontes e data em references/multimodal.md.
// O catálogo ao vivo prova modalidade + endpoint; não prova limites nem qualidade.
export const DEFAULT_MODEL = "typesafe/jev-1.14";
export const NATIVE_VIDEO_MODEL = "cloudflare/clef-omni";
export const CATALOG_URL = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
export const PROFILE_DATE = "2026-11-04";
const MiB = 1024 * 1024;

const jev = {
  adapter: "typesafe", input: ["text", "image"], primitives: ["noul", "choice", "score"],
  context: 64_000, questionContext: 32_000, imageContext: 262_144,
  maxBodyBytes: 32 * MiB, maxImageBytes: 16 * MiB, maxImageTotalBytes: 32 * MiB,
  minImageAxis: 280, maxImageAxis: 1568, maxImages: 64, // 64 = teto operacional LOCAL
  topLevelMedia: false, experimentalImages: true,
};
export const MODEL_PROFILES = Object.freeze({
  "typesafe/jev-1.13": Object.freeze({ ...jev }),
  "typesafe/jev-1.14": Object.freeze({ ...jev, primitives: [...jev.primitives, "box"] }),
  "cloudflare/clef-omni": Object.freeze({
    adapter: "cloudflare-omni", input: ["text", "image", "video", "audio"],
    primitives: ["noul", "choice", "score"], context: 65_536, questionContext: 65_536,
    maxBodyBytes: 32 * MiB, // teto operacional LOCAL para JSON/base64
    maxImageBytes: 4 * MiB, maxImageTotalBytes: 8 * MiB, maxImages: 4,
    minImageAxis: 280, maxImageAxis: 1568, // normalização conservadora LOCAL
    maxVideos: 2, maxVideoBytes: 16 * MiB, maxAVBytes: 16 * MiB,
    maxVideoSeconds: 60, videoFps: 2, maxQuestions: 64, topLevelMedia: true,
    experimentalImages: false,
  }),
});

export function normalizeModel(id = DEFAULT_MODEL) {
  if (id === "jev-latest" || id === "~typesafe/jev-latest") return "~typesafe/jev-latest";
  const m = /^(?:typesafe\/)?jev-(1\.(?:13|14))(?:\.0|-\d{8})?$/.exec(id);
  return m ? `typesafe/jev-${m[1]}` : id;
}

export function profileFor(id = DEFAULT_MODEL) {
  // Não adivinhamos as primitivas de aliases móveis: fixe 1.14 para usar box.
  const normalized = normalizeModel(id);
  return Object.hasOwn(MODEL_PROFILES, normalized) ? MODEL_PROFILES[normalized] : null;
}

let cached = null;
/** Descoberta pública, sem chave e sem enviar conteúdo do utilizador. */
export async function listDecisionModels(opts = {}) {
  const now = Date.now();
  if (!opts.fetchImpl && cached && now - cached.at < 300_000 && !opts.refresh) return cached.models;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  if (!response.ok) throw new Error(`Catálogo OpenRouter: HTTP ${response.status}.`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data)) throw new Error("Catálogo OpenRouter sem data[].");
  const models = payload.data.filter((m) =>
    m.architecture?.output_modalities?.includes("decisions") &&
    // Alguns modelos de extractions também anunciam output_modalities=decisions.
    Array.isArray(m.endpoints) && m.endpoints.includes("/api/alpha/decisions"));
  if (!opts.fetchImpl) cached = { at: now, models };
  return models;
}

export async function verifyModel(id, modalities = ["text"], opts = {}) {
  const models = await listDecisionModels(opts);
  const normalized = normalizeModel(id);
  const model = models.find((m) => m.id === id || m.id === normalized || m.canonical_slug === id);
  if (!model) throw new Error(`Modelo ${id} não anuncia /api/alpha/decisions no catálogo atual. Use o comando models.`);
  for (const kind of modalities) {
    if (!model.architecture.input_modalities?.includes(kind)) {
      throw new Error(`${id} não anuncia entrada ${kind}; não enviaremos mídia como JSON/texto por engano.`);
    }
  }
  return { id: model.id, canonical_slug: model.canonical_slug, input: model.architecture.input_modalities,
    output: model.architecture.output_modalities, endpoints: model.endpoints, pricing: model.pricing,
    context_length: model.context_length, verified_at: new Date().toISOString() };
}
