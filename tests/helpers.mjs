import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const exec = promisify(execFile);
const TEMP_PREFIX = "jev-multimodal-test-";
const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let n = byte;
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload = Buffer.alloc(0)) {
  const tag = Buffer.from(type, "ascii");
  const out = Buffer.alloc(payload.length + 12);
  out.writeUInt32BE(payload.length, 0);
  tag.copy(out, 4);
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([tag, payload])), payload.length + 8);
  return out;
}

/** A decodable RGB PNG: genuine IHDR, filtered scanlines, zlib IDAT and CRCs. */
export function png(width = 280, height = 280, { noise = false, splitColors = false, animated = false } = {}) {
  assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let seed = 0x51f15e;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * stride + 1 + x * 3;
      if (noise) {
        for (let c = 0; c < 3; c++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          raw[offset + c] = seed & 0xff;
        }
      } else if (splitColors) {
        raw[offset] = x < width / 2 ? 240 : 8;
        raw[offset + 1] = 12;
        raw[offset + 2] = x < width / 2 ? 8 : 240;
      } else {
        raw[offset] = 16;
        raw[offset + 1] = 128;
        raw[offset + 2] = 200;
      }
    }
  }
  const chunks = [chunk("IHDR", ihdr)];
  if (animated) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(1, 0);
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt16BE(1, 20);
    fctl.writeUInt16BE(1, 22);
    chunks.push(chunk("acTL", actl), chunk("fcTL", fctl));
  }
  chunks.push(chunk("IDAT", deflateSync(raw)), chunk("IEND"));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

export function dataUrl(bytes, mime = "image/png") {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export function imagePart(bytes = png(), mime = "image/png") {
  return { type: "image_url", image_url: { url: dataUrl(bytes, mime) } };
}

/** Add a real EXIF APP1 segment to a JPEG produced by a decoder/encoder. */
export function jpegWithExif(jpeg, orientation, littleEndian = true) {
  assert.equal(jpeg.readUInt16BE(0), 0xffd8);
  const payload = Buffer.alloc(32);
  payload.write("Exif\0\0", 0, "ascii");
  payload.write(littleEndian ? "II" : "MM", 6, "ascii");
  const u16 = (value, at) => littleEndian ? payload.writeUInt16LE(value, at) : payload.writeUInt16BE(value, at);
  const u32 = (value, at) => littleEndian ? payload.writeUInt32LE(value, at) : payload.writeUInt32BE(value, at);
  u16(42, 8);
  u32(8, 10);
  u16(1, 14);
  u16(0x0112, 16);
  u16(3, 18);
  u32(1, 20);
  u16(orientation, 24);
  const marker = Buffer.from([0xff, 0xe1, 0, payload.length + 2]);
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
}

export async function runProgram(binary, args, options = {}) {
  return exec(binary, args, { shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, ...options });
}

export async function binaryAvailable(binary) {
  try {
    await runProgram(binary, ["-version"]);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function fixtureDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const intended = path.resolve(root);
  return {
    root,
    async cleanup() {
      // Verify the exact absolute deletion target, its parent and our own prefix.
      const absolute = path.resolve(root);
      assert.ok(path.isAbsolute(absolute));
      assert.equal(absolute, intended);
      assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
      assert.ok(path.basename(absolute).startsWith(TEMP_PREFIX));
      await fs.rm(absolute, { recursive: true, force: true });
    },
  };
}
