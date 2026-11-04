import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRequest } from "../scripts/lib/validate.mjs";
import { analyze } from "../scripts/lib/analyze.mjs";
import { imagePart, png } from "./helpers.mjs";
const image = imagePart(png());
const base = { model: "typesafe/jev-1.14", questions: { visible: { type: "noul", instructions: "Is the target visible?" } } };

test("a mistyped media type is not silently classified as ordinary JSON text", () => {
  const v = validateRequest({ ...base, state: [{ ...image, type: "image_ur1" }] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "media.part_type"));
});

test("an inline media payload requires its discriminator, while ordinary URL metadata remains text", () => {
  const missing = validateRequest({ ...base, state: [{ image_url: image.image_url }] });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.code === "media.part_type"));
  assert.equal(validateRequest({ ...base, state: { image_url: "https://example.invalid/not-downloaded" } }).ok, true);
});

test("Responses input_image is not accepted as a Decisions media part", () => {
  const v = validateRequest({ ...base, state: [{ type: "input_image", image_url: image.image_url.url }] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "media.part_type"));
});

test("invalid transport and helper timeouts fail before preparation/catalog/inference, including dry-run", async () => {
  let calls = 0;
  const denied = async () => { calls++; throw new Error("unexpected external operation"); };
  for (const option of [{ retries: NaN }, { timeoutMs: 0 }, { catalogTimeoutMs: NaN }, { mediaTimeoutMs: -1 }]) {
    await assert.rejects(analyze({ ...base, state: "offline" }, { ...option, dryRun: true, verifyModelFn: denied, decideFn: denied }), (e) => e.exitCode === 2);
    await assert.rejects(analyze({ ...base, state: "offline" }, { ...option, verifyModelFn: denied, decideFn: denied }), (e) => e.exitCode === 2);
  }
  assert.equal(calls, 0);
});
