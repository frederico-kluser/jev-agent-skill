// validate.mjs — Validação de requisições e respostas do Jev baseada nos conceitos
// do modelo (System One / TypeSafe). Zero dependências.
//
// Conceitos respeitados (fontes: docs.typesafe.ai /api, /primitives, /confidence,
// /models e a Decisions API do OpenRouter):
//   * O Jev NÃO gera texto: perguntas só podem pedir decisões tipadas.
//   * Três primitivas: `noul` (probabilidade de sim), `choice` (1 opção de N,
//     cardinalidade máx. 255) e `score` (posição ponderada numa régua ordenada).
//   * `instructions` carrega o julgamento; `criteria` define as respostas possíveis.
//   * Um julgamento atómico por pergunta; dimensões independentes = perguntas
//     separadas, avaliadas em paralelo sobre o MESMO state.
//   * Orçamento: 64k tokens por pedido; `state` + pergunta mais longa ≤ 32k.
//   * `confidence` existe só em choice/score (é a concentração da distribuição);
//     `noul` não traz confidence — a incerteza vive na distância de 0.5.
//   * Jaggedness: contagens exatas, aritmética, datas e multi-hop são falhas
//     documentadas — pertencem a código determinístico, não ao Jev.
//   * Inglês é a língua primária; pt-BR funciona mas exige calibração própria.

export const LIMITS = {
  REQUEST_TOTAL_TOKENS: 64_000,        // state + todas as perguntas combinadas
  STATE_PLUS_LONGEST_Q_TOKENS: 32_000, // state + a pergunta mais longa
  CHOICE_MAX_OPTIONS: 255,             // cardinalidade máxima documentada
  SCORE_MIN_LEVELS: 2,                 // "A Score should have at least two levels"
  SCORE_MAX_LEVELS: 10,                // "the API accepts up to 10"
  QUESTION_ID_MAX_LEN: 96,
  SESSION_ID_MAX_LEN: 256,
  USER_MAX_LEN: 256,
};

export const QUESTION_TYPES = Object.freeze(["noul", "choice", "score"]);
export const MODEL_IDS_KNOWN = Object.freeze([
  "typesafe/jev-1.13", "~typesafe/jev-latest", "typesafe/jev-1.13.0",
  "jev-1.13", "jev-1.13.0", "jev-latest", "jev-preview",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimativa grosseira de tokens (≈ chars/4). Serve para orçamento, não para faturação. */
export function estimateTokens(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil((s || "").length / 4);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `instructions`/`criteria` aceitam string, objeto ou array (schema oficial).
 *  `null` é aceite pelo EntryType oficial para itens autoexplicativos. */
function isGuidance(v, allowNull = false) {
  if (v === null) return allowNull;
  if (typeof v === "string") return v.trim().length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return false;
}

function guidanceText(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

class Report {
  constructor() { this.errors = []; this.warnings = []; this.info = []; }
  err(code, msg, where) { this.errors.push({ code, msg, where }); }
  warn(code, msg, where) { this.warnings.push({ code, msg, where }); }
  note(code, msg, where) { this.info.push({ code, msg, where }); }
  get ok() { return this.errors.length === 0; }
  toJSON() {
    return { ok: this.ok, errors: this.errors, warnings: this.warnings, info: this.info };
  }
}

// ---------------------------------------------------------------------------
// Lints de CONCEITO do modelo (jaggedness, atomicidade, geração proibida)
// ---------------------------------------------------------------------------

const GENERATIVE_PATTERNS = /\b(explain|explain why|justify|write|generate|draft|summarize|translate|rewrite|describe in detail)\b|(explique|explique porquê|justifique|escreva|gere|redija|resuma|resumo de|traduza|reescreva|descreva em detalhe)/i;

// Falhas documentadas de jaggedness: contagem, aritmética exata, datas, multi-hop.
// Fronteiras de palavra são obrigatórias: sem elas, "conte" casa dentro de "content".
const JAGGED_PATTERNS = /\b(how many|count(?: the)?|sum|add up|calculate|compute|multiply|divide|percentage of|what date|which date|how old|how long ago|days between|exact number|total number)\b|\b(quantos?|quantas?|conte|contar|somar|calcule|calcular|multiplique|divida|percentual de|qual data|que data|quantos dias|quantos anos|há quanto tempo|número exato|total de)\b/i;

const NO_MATCH_KEYS = /^(other|others|unknown|none|n\/?a|not[_ -]?applicable|unclear|outro|outra|outros|outras|nenhum|nenhuma|não[_ -]?se[_ -]?aplica|indeterminado|indefinido)$/i;

function lintInstructions(report, qid, type, instructions) {
  const text = guidanceText(instructions);

  if (GENERATIVE_PATTERNS.test(text)) {
    report.warn("generative",
      `A pergunta parece pedir geração/explicação textual. O Jev NÃO gera texto — ele só escolhe entre as opções de \`criteria\`. Reescreva como julgamento tipado (ex.: "Qual o motivo principal?" com opções em criteria).`,
      `questions.${qid}`);
  }

  if (JAGGED_PATTERNS.test(text)) {
    report.warn("jaggedness",
      `A pergunta depende de contagem/aritmética/data exata — falha documentada do Jev (jaggedness). Calcule em código determinístico e envie o RESULTADO no \`state\`; peça ao Jev só o julgamento semântico.`,
      `questions.${qid}`);
  }

  // Atomicidade: mais do que um "?" ou conectores de junção típicos de perguntas compostas.
  const questionMarks = (text.match(/\?/g) || []).length;
  const compoundEN = /\b(and also|as well as|plus whether|and whether|and what|and how|and needs|and is|and has|and should|and wants|and asks)\b/i;
  const compoundPT = /(?:^|[\s,;("'])e\s+(?:também|se|qual|quais|como|quantos?|precisa|está|tem|deve|quer|pede|solicita|requer|reporta)\b|(?:^|[\s,;("'])bem\s+como\b/i;
  const compound = compoundEN.test(text) || compoundPT.test(text);
  if (questionMarks > 1 || compound) {
    report.warn("atomicity",
      `A pergunta parece conter MÚLTIPLOS julgamentos. Divida em perguntas separadas no mesmo mapa — o Jev avalia todas em paralelo sobre o mesmo state, sem custo extra de latência.`,
      `questions.${qid}`);
  }
}

// ---------------------------------------------------------------------------
// Validação de requisição
// ---------------------------------------------------------------------------

/**
 * Valida uma requisição no formato Decisions API (`POST /api/alpha/decisions`).
 * Retorna { ok, errors, warnings, info, budget }.
 */
export function validateRequest(req, opts = {}) {
  const report = new Report();
  const budget = { state_tokens: 0, questions_tokens: 0, total_tokens: 0, longest_question_tokens: 0 };

  if (!isPlainObject(req)) {
    report.err("request.type", "A requisição deve ser um objeto JSON { model, state, questions }.");
    return { ...report.toJSON(), budget };
  }

  // --- state ---------------------------------------------------------------
  if (!("state" in req)) {
    report.err("state.missing", "Campo obrigatório `state` em falta.", "state");
  } else if (!(typeof req.state === "string" || isPlainObject(req.state) || Array.isArray(req.state))) {
    report.err("state.type", "`state` deve ser string, objeto JSON ou array.", "state");
  } else if (typeof req.state === "string" && req.state.trim().length === 0) {
    report.err("state.empty", "`state` vazio — nada para avaliar.", "state");
  }

  // --- model ---------------------------------------------------------------
  if (!("model" in req) || typeof req.model !== "string" || req.model.trim() === "") {
    report.warn("model.missing",
      "Sem `model`; o padrão da skill é `typesafe/jev-1.13` (fixe a versão se calibrar thresholds contra ela).", "model");
  } else if (!MODEL_IDS_KNOWN.includes(req.model) && !opts.allowUnknownModel) {
    report.warn("model.unknown",
      `Modelo "${req.model}" fora da lista conhecida (${MODEL_IDS_KNOWN.join(", ")}). Confirme o ID no OpenRouter (GET /api/v1/models?q=jev).`, "model");
  }

  // --- session_id / user ---------------------------------------------------
  if (typeof req.session_id === "string" && req.session_id.length > LIMITS.SESSION_ID_MAX_LEN) {
    report.err("session_id.len", `\`session_id\` deve ter no máximo ${LIMITS.SESSION_ID_MAX_LEN} caracteres.`, "session_id");
  }
  if (typeof req.user === "string" && req.user.length > LIMITS.USER_MAX_LEN) {
    report.err("user.len", `\`user\` deve ter no máximo ${LIMITS.USER_MAX_LEN} caracteres.`, "user");
  }

  // --- questions -----------------------------------------------------------
  const questions = req.questions;
  if (!isPlainObject(questions)) {
    report.err("questions.type", "`questions` deve ser um mapa { id: pergunta }.", "questions");
    return { ...report.toJSON(), budget };
  }
  const qids = Object.keys(questions);
  if (qids.length === 0) {
    report.err("questions.empty", "Mapa `questions` vazio — forneça pelo menos uma pergunta tipada.", "questions");
    return { ...report.toJSON(), budget };
  }
  if (qids.length > 64) {
    report.warn("questions.count",
      `${qids.length} perguntas num único pedido. Funciona (avaliação é paralela), mas orçamento de tokens e depuração ficam piores — considere dividir.`, "questions");
  }

  for (const qid of qids) {
    const where = `questions.${qid}`;
    const q = questions[qid];

    // ID da pergunta: não vai para o modelo; é para o SEU código.
    if (typeof qid !== "string" || qid.trim() === "") {
      report.err("question.id", "ID de pergunta vazio.", where);
      continue;
    }
    if (qid.length > LIMITS.QUESTION_ID_MAX_LEN) {
      report.warn("question.id_len",
        `ID "${qid.slice(0, 20)}…" tem mais de ${LIMITS.QUESTION_ID_MAX_LEN} caracteres — IDs são para o código; use nomes curtos e estáveis.`, where);
    }
    if (/\s{2,}/.test(qid)) {
      report.warn("question.id_space", "ID de pergunta com espaços duplos — prefira snake_case estável (ex.: `is_urgent`).", where);
    }

    if (!isPlainObject(q)) {
      report.err("question.type", "Cada pergunta deve ser um objeto { type, instructions, criteria? }.", where);
      continue;
    }
    if (!QUESTION_TYPES.includes(q.type)) {
      report.err("question.primitive",
        `\`type\` inválido: ${JSON.stringify(q.type)}. Primitivas válidas: ${QUESTION_TYPES.join(", ")}.`, where);
      continue;
    }
    if (q.instructions === undefined) {
      report.err("question.instructions",
        "`instructions` obrigatório (string/objeto/array) — é o julgamento que o modelo executa. O ID da pergunta NÃO vai para o modelo.", where);
    } else if (q.instructions === null) {
      report.warn("question.instructions_null",
        "`instructions` null — o modelo recebe um julgamento sem texto; escreva a pergunta completa em `instructions`.", where);
    } else if (!isGuidance(q.instructions)) {
      report.err("question.instructions",
        "`instructions` vazio — é o julgamento que o modelo executa.", where);
    } else {
      lintInstructions(report, qid, q.type, q.instructions);
    }

    if (q.type === "noul") {
      // criteria é opcional; se existir, exige as DUAS chaves.
      if ("criteria" in q && q.criteria !== undefined && q.criteria !== null) {
        if (!isPlainObject(q.criteria)) {
          report.err("noul.criteria",
            "Em `noul`, `criteria` deve ser { \"true\": …, \"false\": … } (ou omitido).", where);
        } else {
          const keys = Object.keys(q.criteria);
          const hasTrue = keys.includes("true");
          const hasFalse = keys.includes("false");
          if (!hasTrue || !hasFalse) {
            report.err("noul.criteria_pair",
              "`criteria` de `noul` precisa de AMBAS as chaves \"true\" e \"false\" quando presente.", where);
          }
          for (const k of keys) {
            if (k !== "true" && k !== "false") {
              report.warn("noul.criteria_extra",
                `Chave inesperada "${k}" em criteria de noul — só "true"/"false\" têm efeito.`, where);
            }
          }
        }
      }
    }

    if (q.type === "choice") {
      if (!isPlainObject(q.criteria)) {
        report.err("choice.criteria",
          "`choice` exige `criteria`: mapa { opcao: descricao } com as alternativas permitidas.", where);
      } else {
        const opts_ = Object.keys(q.criteria);
        if (opts_.length === 0) {
          report.err("choice.criteria_empty", "`criteria` de `choice` vazio.", where);
        } else if (opts_.length === 1) {
          report.warn("choice.criteria_single",
            "`choice` com uma única opção não é decisão — use `noul` ou acrescente alternativas.", where);
        }
        if (opts_.length > LIMITS.CHOICE_MAX_OPTIONS) {
          report.err("choice.cardinality",
            `Cardinality ${opts_.length} excede o máximo de ${LIMITS.CHOICE_MAX_OPTIONS} opções suportadas pelo Jev. Hierarquize: escolha em 2 níveis (agrupamento → detalhe).`, where);
        }
        for (const k of opts_) {
          if (k.trim() === "") report.err("choice.option_empty", "Opção com chave vazia em `criteria`.", where);
          if (!isGuidance(q.criteria[k], true)) {
            report.err("choice.option_desc",
              `Descrição inválida para a opção "${k}" — use texto/objeto/array, ou null para opções autoexplicativas.`, where);
          }
        }
        if (!opts_.some((k) => NO_MATCH_KEYS.test(k.trim()))) {
          report.warn("choice.no_match",
            "Sem opção de saída (ex.: `other`/`none`). Inclua uma quando o estado puder não caber em nenhuma alternativa — evita forçar classificações erradas.", where);
        }
      }
    }

    if (q.type === "score") {
      if (!Array.isArray(q.criteria)) {
        report.err("score.criteria",
          "`score` exige `criteria`: ARRAY ordenado de níveis (do menor ao maior).", where);
      } else if (q.criteria.length === 0) {
        report.err("score.criteria_empty", "`criteria` de `score` vazio.", where);
      } else {
        const n = q.criteria.length;
        if (n < LIMITS.SCORE_MIN_LEVELS) {
          report.warn("score.levels_min",
            `Régua com ${n} nível(ais) — "a Score should have at least two levels"; abaixo disso use \`noul\`.`, where);
        }
        if (n > LIMITS.SCORE_MAX_LEVELS) {
          report.err("score.levels_max",
            `${n} níveis excede o máximo aceite pela API (${LIMITS.SCORE_MAX_LEVELS}). Níveis acima de ~10 também são indistinguíveis na prática — consolide a régua.`, where);
        }
        const seen = new Set();
        q.criteria.forEach((level, i) => {
          if (!isGuidance(level, true)) {
            report.err("score.level_desc", `Nível ${i} de \`criteria\` vazio.`, where);
          } else {
            const t = guidanceText(level).trim().toLowerCase();
            if (seen.has(t)) report.warn("score.level_dup", `Níveis duplicados (${i}) — cada nível deve descrever uma situação concreta e única; o modelo julga cada nível de forma independente.`, where);
            seen.add(t);
          }
          // Níveis puramente numéricos ("0","1","2") têm desempenho documentado como mau.
          if (typeof level === "string" && /^\s*\d+(\.\d+)?\s*$/.test(level)) {
            report.warn("score.level_numeric",
              `Nível ${i} é puramente numérico ("${level}") — desempenho documentado como fraco. Descreva a SITUAÇÃO concreta de cada nível.`, where);
          }
        });
      }
    }
  }

  // --- orçamento de tokens (64k total; state + pergunta mais longa ≤ 32k) ---
  budget.state_tokens = estimateTokens(req.state ?? "");
  let longestQ = 0;
  let allQ = 0;
  for (const qid of qids) {
    const t = estimateTokens(questions[qid]);
    allQ += t;
    longestQ = Math.max(longestQ, t);
  }
  budget.questions_tokens = allQ;
  budget.longest_question_tokens = longestQ;
  budget.total_tokens = budget.state_tokens + allQ;

  if (budget.state_tokens + longestQ > LIMITS.STATE_PLUS_LONGEST_Q_TOKENS) {
    report.err("budget.state",
      `state + pergunta mais longa ≈ ${budget.state_tokens + longestQ} tokens estimados > limite de ${LIMITS.STATE_PLUS_LONGEST_Q_TOKENS}. Higienize o state (veja references/validacao.md).`,
      "state");
  } else if (budget.state_tokens + longestQ > LIMITS.STATE_PLUS_LONGEST_Q_TOKENS * 0.8) {
    report.warn("budget.state_near",
      `state + pergunta mais longa ≈ ${budget.state_tokens + longestQ} tokens — perto do limite de ${LIMITS.STATE_PLUS_LONGEST_Q_TOKENS}. Contexto enorme degrada a precisão (jaggedness vs. tamanho do state).`,
      "state");
  }
  if (budget.total_tokens > LIMITS.REQUEST_TOTAL_TOKENS) {
    report.err("budget.total",
      `Pedido total ≈ ${budget.total_tokens} tokens estimados > limite de ${LIMITS.REQUEST_TOTAL_TOKENS}. Divida o state ou reduza perguntas.`,
      "questions");
  }

  // --- higiene do state ----------------------------------------------------
  if (typeof req.state === "string" && /[\u0000-\u0008]/.test(req.state)) {
    report.warn("state.binary", "O `state` contém bytes de controlo/binários — converta não-texto para texto ANTES de enviar (Jev só ingere texto).", "state");
  }
  const b64 = typeof req.state === "string" ? (req.state.match(/[A-Za-z0-9+/]{200,}={0,2}/g) || []) : [];
  if (b64.length > 0) {
    report.warn("state.blob",
      "O `state` parece conter blobs base64 grandes — ruído que não ajuda julgamentos semânticos e consome orçamento (context rot).", "state");
  }

  // --- língua --------------------------------------------------------------
  const stateText = typeof req.state === "string" ? req.state : JSON.stringify(req.state ?? "");
  const nonAscii = (stateText.match(/[^\x00-\x7F]/g) || []).length;
  if (stateText.length > 40 && nonAscii / stateText.length > 0.15) {
    report.note("language.non_english",
      "State majoritariamente não-inglês: o Jev tem melhor precisão em inglês; para pt-BR valide com casos seus e use as bandas de confiança (references/validacao.md §Calibração).",
      "state");
  }

  return { ...report.toJSON(), budget };
}

// ---------------------------------------------------------------------------
// Validação de resposta + bandas de decisão
// ---------------------------------------------------------------------------

export const DEFAULT_THRESHOLDS = Object.freeze({ auto: 0.90, hitl: 0.50 });

/**
 * Classifica uma resposta em bandas de ação:
 *   auto  → executar sem intervenção        (confiança ≥ auto)
 *   hitl  → confirmar com humano            (confiança ≥ hitl)
 *   abstain → não agir; cair p/ Sistema Dois (abaixo de hitl)
 * `noul` não traz `confidence`: usa-se a certeza = max(p, 1-p).
 */
export function decideBand(answer, thresholds = DEFAULT_THRESHOLDS) {
  const auto = thresholds.auto ?? DEFAULT_THRESHOLDS.auto;
  const hitl = thresholds.hitl ?? DEFAULT_THRESHOLDS.hitl;
  if (answer?.type === "noul" || (answer && "noul" in (answer || {}))) {
    const p = Number(answer.noul);
    if (!Number.isFinite(p)) return { band: "abstain", basis: "noul", certainty: null, ambiguous: true };
    const certainty = Math.max(p, 1 - p);
    let band = "abstain";
    if (certainty >= auto) band = "auto";
    else if (certainty >= Math.max(hitl, 0.5)) band = "hitl";
    return { band, basis: "noul_certainty", certainty: round4(certainty), ambiguous: Math.abs(p - 0.5) < 0.1, p_yes: round4(p) };
  }
  const c = Number(answer?.confidence);
  if (!Number.isFinite(c)) return { band: "abstain", basis: "missing_confidence", confidence: null };
  let band = "abstain";
  if (c >= auto) band = "auto";
  else if (c >= hitl) band = "hitl";
  return { band, basis: "confidence", confidence: round4(c) };
}

function round4(x) { return Math.round(x * 1e4) / 1e4; }

/**
 * Valida a coerência da resposta contra a requisição (probabilidades somam ~1,
 * `choice` ∈ criteria, score dentro da régua, legend coerente…).
 */
export function validateResponse(req, res, thresholds = DEFAULT_THRESHOLDS) {
  const report = new Report();
  const decisions = {};

  if (!isPlainObject(res)) {
    report.err("response.type", "Resposta não é um objeto JSON.");
    return { ...report.toJSON(), decisions };
  }
  if (!isPlainObject(res.answers)) {
    report.err("response.answers", "Resposta sem `answers`.");
    return { ...report.toJSON(), decisions };
  }
  const questions = isPlainObject(req?.questions) ? req.questions : {};

  for (const [qid, q] of Object.entries(questions)) {
    const where = `answers.${qid}`;
    const a = res.answers[qid];
    if (a === undefined) {
      report.err("answer.missing", `Sem resposta para a pergunta "${qid}".`, where);
      continue;
    }
    if (a.type !== q.type) {
      report.err("answer.type_mismatch",
        `Tipo da resposta (${a.type}) difere do pedido (${q.type}).`, where);
      continue;
    }

    if (q.type === "noul") {
      const p = Number(a.noul);
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        report.err("noul.range", `\`noul\` fora de [0,1]: ${a.noul}`, where);
      } else {
        decisions[qid] = { value: p, ...decideBand(a, thresholds) };
        if (p > 0.4 && p < 0.6) {
          report.note("noul.ambiguous",
            `noul=${p} ≈ indeciso (não é "intensidade média" — é 50/50). Não aja automaticamente.`, where);
        }
      }
      continue;
    }

    if (q.type === "choice") {
      const probs = isPlainObject(a.probabilities) ? a.probabilities : null;
      if (!probs) {
        report.warn("choice.no_probabilities", "Resposta `choice` sem `probabilities` — impossível verificar calibração.", where);
      } else {
        checkDistribution(report, probs, isPlainObject(q.criteria) ? Object.keys(q.criteria) : null, where);
      }
      if (typeof a.choice !== "string" || a.choice === "") {
        report.err("choice.missing", "Resposta `choice` sem campo `choice`.", where);
      } else if (isPlainObject(q.criteria) && !(a.choice in q.criteria)) {
        report.err("choice.not_in_criteria",
          `Escolha "${a.choice}" não pertence ao \`criteria\` pedido — nunca deveria acontecer (o Jev não alucina formato); reporte como bug de transporte/parse.`, where);
      }
      const c = a.confidence;
      if (c !== undefined && (typeof c !== "number" || c < 0 || c > 1)) {
        report.err("choice.confidence_range", `\`confidence\` fora de [0,1]: ${c}`, where);
      }
      decisions[qid] = { value: a.choice, ...decideBand(a, thresholds) };
      continue;
    }

    // score
    const levels = Array.isArray(q.criteria) ? q.criteria : [];
    const s = Number(a.score);
    if (!Number.isFinite(s)) {
      report.err("score.missing", "Resposta `score` sem campo `score` numérico.", where);
    } else {
      const maxLevel = Math.max(0, levels.length - 1);
      if (s < 0 || s > maxLevel) {
        report.warn("score.out_of_scale",
          `score=${s} fora da régua [0, ${maxLevel}] definida pelos ${levels.length} níveis.`, where);
      }
      decisions[qid] = { value: s, ...decideBand(a, thresholds) };
      if (levels.length > 1) {
        decisions[qid].normalized = round4(s / (levels.length - 1)); // 0..1 p/ composição de scores
      }
    }
    const probs = isPlainObject(a.probabilities) ? a.probabilities : null;
    if (probs) {
      checkDistribution(report, probs, null, where);
      if (levels.length > 0) {
        for (const k of Object.keys(probs)) {
          const idx = Number(k);
          if (!Number.isInteger(idx) || idx < 0 || idx >= levels.length) {
            report.warn("score.legend_key",
              `Chave "${k}" nas probabilities não corresponde a nenhum índice da régua (0..${levels.length - 1}).`, where);
          }
        }
      }
    } else {
      report.warn("score.no_probabilities", "Resposta `score` sem `probabilities` — impossível verificar calibração.", where);
    }
    if (isPlainObject(a.legend) && levels.length > 0) {
      for (const k of Object.keys(a.legend)) {
        const idx = Number(k);
        if (!Number.isInteger(idx) || idx < 0 || idx >= levels.length) {
          report.warn("score.legend_mismatch",
            `legend["${k}"] não corresponde a um índice da régua enviada.`, where);
        } else {
          // O legend ecoa as descrições dos níveis ENVIADOS — se divergir, houve
          // corrupção de transporte/parse (o modelo nunca reescreve o criteria).
          const echoed = a.legend[k];
          const sent = levels[idx];
          const norm = (v) => (typeof v === "string" ? v.trim() : JSON.stringify(v ?? null));
          if (norm(echoed) !== norm(sent)) {
            report.warn("score.legend_echo_mismatch",
              `legend[${k}] não ecoa o nível enviado ("${norm(sent).slice(0, 60)}" vs "${norm(echoed).slice(0, 60)}").`, where);
          }
        }
      }
    }
    const c2 = a.confidence;
    if (c2 !== undefined && (typeof c2 !== "number" || c2 < 0 || c2 > 1)) {
      report.err("score.confidence_range", `\`confidence\` fora de [0,1]: ${c2}`, where);
    }
  }

  for (const qid of Object.keys(res.answers)) {
    if (!(qid in questions)) {
      report.note("answer.extra", `Resposta para "${qid}" não pedido (ignorado).`, `answers.${qid}`);
    }
  }

  if (res.usage === undefined) {
    report.warn("usage.missing", "Resposta sem `usage` — sem custo/tokens registados.", "usage");
  } else if (res.usage && (typeof res.usage.input_tokens !== "number" || typeof res.usage.output_tokens !== "number")) {
    report.warn("usage.shape", "`usage` sem `input_tokens`/`output_tokens` numéricos.", "usage");
  }

  return { ...report.toJSON(), decisions };
}

function checkDistribution(report, probs, expectedKeys, where) {
  const vals = Object.values(probs).map(Number);
  if (vals.some((v) => !Number.isFinite(v) || v < -1e-9 || v > 1 + 1e-9)) {
    report.err("probabilities.range", "Probabilidade fora de [0,1] na distribuição.", where);
    return;
  }
  const sum = vals.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.02) {
    report.warn("probabilities.sum",
      `Distribuição soma ${sum.toFixed(4)} (esperado ≈ 1). Verifique o parse da resposta.`, where);
  }
  if (expectedKeys && expectedKeys.length > 0) {
    const missing = expectedKeys.filter((k) => !(k in probs));
    if (missing.length > 0) {
      report.warn("probabilities.coverage",
        `Opções do criteria sem probabilidade: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`, where);
    }
  }
}
