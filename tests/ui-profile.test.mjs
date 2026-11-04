// Perfil de SCREENSHOT/UI e preset — a escolha vem de um benchmark medido,
// não de marketing; aqui travamos o contrato do adaptador e o fail-closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UI_SCREENSHOT_MODEL, profileFor, MODEL_PROFILES } from "../scripts/lib/capabilities.mjs";
import { validateRequest } from "../scripts/lib/validate.mjs";
import { decodeDataUrl } from "../scripts/lib/media-info.mjs";
import { imagePart, png } from "./helpers.mjs";

test("o perfil UI tem o contrato do adaptador (sem box, imagem só no topo, até 8)", () => {
  assert.equal(UI_SCREENSHOT_MODEL, "perplexity/pplx-decider-v1.2");
  const p = profileFor(UI_SCREENSHOT_MODEL);
  assert.ok(p, "o modelo escolhido precisa de perfil implementado");
  assert.deepEqual(p.primitives, ["noul", "choice", "score"]);
  assert.deepEqual(p.input, ["text", "image"]);
  assert.equal(p.topLevelMedia, true);
  assert.equal(p.maxImages, 8);
  assert.ok(Object.isFrozen(MODEL_PROFILES));
});

test("imagem no topo do state é aceita; aninhada é recusada por este adaptador", () => {
  const base = { model: UI_SCREENSHOT_MODEL, questions: { v: { type: "noul", instructions: "Is it visible?" } } };
  const topo = validateRequest({ ...base, state: ["Captura.", imagePart(png(640, 360))] });
  assert.equal(topo.ok, true, JSON.stringify(topo.errors));
  const aninhada = validateRequest({ ...base, state: { shot: imagePart(png(640, 360)) } });
  assert.equal(aninhada.ok, false);
  assert.ok(aninhada.errors.some((e) => e.code === "media.position"));
});

test("box não existe neste adaptador: o pedido falha antes de gastar", () => {
  const v = validateRequest({
    model: UI_SCREENSHOT_MODEL,
    state: ["Captura.", imagePart(png(640, 360))],
    questions: { b: { type: "box", instructions: "the button" } },
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "question.model_primitive" || e.code === "box.model"));
});

test("o teto de imagens do perfil UI é aplicado", () => {
  const parts = Array.from({ length: 9 }, () => imagePart(png(320, 320)));
  const v = validateRequest({
    model: UI_SCREENSHOT_MODEL,
    state: ["Capturas.", ...parts],
    questions: { v: { type: "noul", instructions: "Any target?" } },
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "media.image_count"));
});

test("a mídia do preset continua a ser Data URL PNG/JPEG válida", () => {
  const { bytes, mime } = decodeDataUrl(imagePart(png(1280, 720)).image_url.url, { kind: "image" });
  assert.equal(mime, "image/png");
  assert.ok(bytes.length > 0);
});
