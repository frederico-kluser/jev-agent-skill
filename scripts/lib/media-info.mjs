// Inspeção determinística de envelopes/headers. Não substitui um decoder de imagem.
export const MiB = 1024 * 1024;
export const MEDIA_TYPES = Object.freeze(["image_url", "video_url", "input_audio"]);

export function decodeDataUrl(url, { kind = "image", maxBytes = 16 * MiB } = {}) {
  if (typeof url !== "string" || url.length > Math.ceil(maxBytes / 3) * 4 + 128) {
    throw new Error(`Data URL ausente ou acima do teto de ${maxBytes} bytes.`);
  }
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!m || !m[1].startsWith(`${kind}/`) || !m[2] || m[2].length % 4 !== 0) {
    throw new Error(`Use data:${kind}/...;base64,... válido; URLs remotos não são descarregados pela Decisions API.`);
  }
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== m[2]) throw new Error("Base64 inválido ou mídia acima do teto de bytes.");
  return { mime: m[1], bytes };
}

/** PNG estático ou JPEG; EXIF é reportado para exigir rotação física no prepare. */
export function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG sem IHDR.");
    let cursor = 8, animated = false, ended = false;
    while (cursor + 12 <= bytes.length) {
      const n = bytes.readUInt32BE(cursor);
      if (cursor + n + 12 > bytes.length) throw new Error("PNG truncado.");
      const tag = bytes.toString("ascii", cursor + 4, cursor + 8);
      if (tag === "acTL") animated = true;
      if (tag === "IEND") { ended = true; break; }
      cursor += n + 12;
    }
    if (!ended) throw new Error("PNG sem IEND.");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height) throw new Error("PNG com dimensões inválidas.");
    return { mime: "image/png", width, height, orientation: 1, animated };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Formato não é PNG/JPEG estático. Converta com FFmpeg antes de usar o payload direto.");
  let cursor = 2, dimensions = null, orientation = 1;
  while (cursor + 4 <= bytes.length) {
    if (bytes[cursor++] !== 0xff) throw new Error("JPEG com marcador inválido.");
    while (bytes[cursor] === 0xff) cursor++;
    const marker = bytes[cursor++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const n = bytes.readUInt16BE(cursor);
    if (n < 2 || cursor + n > bytes.length) throw new Error("JPEG truncado.");
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && n >= 8) {
      dimensions = { height: bytes.readUInt16BE(cursor + 3), width: bytes.readUInt16BE(cursor + 5) };
    }
    if (marker === 0xe1 && bytes.toString("ascii", cursor + 2, cursor + 8) === "Exif\0\0") {
      const base = cursor + 8, end = cursor + n;
      try {
        const little = bytes.toString("ascii", base, base + 2) === "II";
        const u16 = (p) => { if (p < base || p + 2 > end) throw new Error(); return little ? bytes.readUInt16LE(p) : bytes.readUInt16BE(p); };
        const u32 = (p) => { if (p < base || p + 4 > end) throw new Error(); return little ? bytes.readUInt32LE(p) : bytes.readUInt32BE(p); };
        const ifd = base + u32(base + 4), count = u16(ifd);
        for (let i = 0; i < Math.min(count, 4096); i++) {
          const p = ifd + 2 + 12 * i;
          if (u16(p) === 0x0112 && u16(p + 2) === 3 && u32(p + 4) === 1) orientation = u16(p + 8);
        }
      } catch { throw new Error("EXIF inválido; reexporte a imagem sem metadados."); }
    }
    cursor += n;
  }
  if (!dimensions?.width || !dimensions?.height) throw new Error("JPEG sem dimensões SOF válidas.");
  return { mime: "image/jpeg", ...dimensions, orientation, animated: false };
}

export function collectMedia(value, where = "state", found = []) {
  if (value && typeof value === "object") {
    if (!Array.isArray(value) && MEDIA_TYPES.includes(value.type)) {
      found.push({ value, where, kind: value.type === "image_url" ? "image" : value.type === "video_url" ? "video" : "audio" });
      return found;
    }
    for (const [key, child] of Object.entries(value)) collectMedia(child, Array.isArray(value) ? `${where}[${key}]` : `${where}.${key}`, found);
  }
  return found;
}

/** Base64 não é texto para estimativa de tokens nem para logs. */
export function withoutMediaData(value) {
  if (Array.isArray(value)) return value.map(withoutMediaData);
  if (value && typeof value === "object") {
    if (MEDIA_TYPES.includes(value.type)) return { type: value.type, media: "[bytes omitted; tokens calculated by provider]" };
    if ((value.type === "image" || ["png", "jpg", "jpeg"].includes(value.format)) && typeof value.data_base64 === "string") return { type: "image", format: value.format, media: "[asset omitted]" };
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutMediaData(v)]));
  }
  return value;
}

/** Só para SAÍDA/logs. Não use para estimar tokens de texto: blobs nus são texto upstream. */
export function redactMediaOutput(value) {
  if (typeof value === "string") return value
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[MEDIA REDACTED]")
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, "[BASE64 REDACTED]")
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[KEY REDACTED]");
  if (Array.isArray(value)) return value.map(redactMediaOutput);
  if (value && typeof value === "object") {
    if (MEDIA_TYPES.includes(value.type)) return { type: value.type, media: "[MEDIA REDACTED]" };
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "data_base64" ? "[BASE64 REDACTED]" : redactMediaOutput(v)]));
  }
  return value;
}

export function normalizedBoxToPixels(box, geometry) {
  const { prepared_width: pw, prepared_height: ph, content_width: cw, content_height: ch,
    pad_left: px, pad_top: py, oriented_width: ow, oriented_height: oh } = geometry;
  if (![pw,ph,cw,ch,ow,oh].every((n) => Number.isFinite(n) && n > 0) || ![px,py].every(Number.isFinite)) throw new Error("Geometria de imagem inválida.");
  if (!box || !["left","right","top","bottom"].every((k) => typeof box[k] === "number" && Number.isFinite(box[k]) && box[k] >= 0 && box[k] <= 1) || box.left >= box.right || box.top >= box.bottom) throw new Error("Box normalizada inválida.");
  const clamp = (n, max) => Math.min(max, Math.max(0, n));
  return {
    left: Math.round(clamp((box.left * pw - px) / cw * ow, ow)),
    right: Math.round(clamp((box.right * pw - px) / cw * ow, ow)),
    top: Math.round(clamp((box.top * ph - py) / ch * oh, oh)),
    bottom: Math.round(clamp((box.bottom * ph - py) / ch * oh, oh)),
    coordinate_space: "oriented_source_pixels", authorization: false,
  };
}
