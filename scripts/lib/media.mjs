// Pré-processamento local. Node stdlib; FFmpeg/FFprobe externos só para mídia.
// Não usa shell, URLs remotos, playlists, uploads públicos nem instalação automática.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeDataUrl, inspectImage, MiB } from "./media-info.mjs";
const exec = promisify(execFile);
export const MEDIA_LIMITS = Object.freeze({ maxInputBytes: 256 * MiB, maxFrames: 64, maxItems: 16, maxPixels: 80_000_000 });

export class MediaError extends Error {
  constructor(message) { super(message); this.name = "MediaError"; this.exitCode = 2; }
}

function numeric(value, fallback, name, min, max, integer = false) {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new MediaError(`${name} deve ser ${integer ? "inteiro " : ""}entre ${min} e ${max}.`);
  }
  return n;
}

async function run(binary, args, opts = {}) {
  try {
    const r = await exec(binary, args, { encoding: opts.binary ? "buffer" : "utf8", timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 20 * MiB, windowsHide: true, shell: false });
    return r.stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new MediaError(`${binary} não encontrado. Instale FFmpeg (com ffprobe), ou configure FFMPEG_PATH/FFPROBE_PATH. Nada foi enviado.`);
    // Não ecoa stderr do decoder: pode conter paths privados e texto do ficheiro.
    throw new MediaError(`Falha no pré-processamento com ${path.basename(binary)} (${e.killed ? "timeout/limite" : "decoder rejeitou a mídia"}). Reexporte como PNG/JPEG ou MP4/WebM; nada foi enviado.`);
  }
}

export function imageGeometry(width, height, { minAxis = 280, maxAxis = 1568, orientation = 1 } = {}) {
  numeric(minAxis, 280, "minAxis", 1, 1568, true);
  numeric(maxAxis, 1568, "maxAxis", minAxis, 1568, true);
  numeric(orientation, 1, "orientation", 1, 8, true);
  if (![width, height].every((n) => Number.isInteger(n) && n > 0) || width * height > MEDIA_LIMITS.maxPixels) throw new MediaError("Dimensões de imagem inválidas ou acima de 80 MP (teto local).");
  const swapped = [5,6,7,8].includes(orientation);
  const ow = swapped ? height : width, oh = swapped ? width : height;
  const scale = Math.min(1, maxAxis / Math.max(ow, oh));
  const cw = Math.max(1, Math.round(ow * scale)), ch = Math.max(1, Math.round(oh * scale));
  const pw = Math.max(minAxis, cw), ph = Math.max(minAxis, ch);
  return { source_width: width, source_height: height, orientation,
    oriented_width: ow, oriented_height: oh, content_width: cw, content_height: ch,
    prepared_width: pw, prepared_height: ph, pad_left: Math.floor((pw - cw) / 2), pad_top: Math.floor((ph - ch) / 2) };
}

function filters(g, { explicitOrientation = false } = {}) {
  const rotate = { 1: "", 2: "hflip", 3: "hflip,vflip", 4: "vflip", 5: "hflip,transpose=2", 6: "transpose=1", 7: "hflip,transpose=1", 8: "transpose=2" };
  return [explicitOrientation ? rotate[g.orientation] : "", `scale=${g.content_width}:${g.content_height}:flags=lanczos`,
    `pad=${g.prepared_width}:${g.prepared_height}:${g.pad_left}:${g.pad_top}:color=black`, "setsar=1"].filter(Boolean).join(",");
}

/** Timestamps pedidos ao seek, NÃO PTS exatos. Cobre todo o intervalo, com teto explícito. */
export function planVideoSamples(duration, config = {}, profileMax = MEDIA_LIMITS.maxFrames, framePeriod = 0.1) {
  numeric(duration, undefined, "duração do vídeo", 0.001, 7 * 24 * 3600);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new MediaError("Configuração de vídeo deve ser objeto.");
  numeric(profileMax, MEDIA_LIMITS.maxFrames, "profileMax", 1, MEDIA_LIMITS.maxFrames, true);
  const fps = numeric(config.fps, 0.5, "video.fps", 0.01, 30);
  const max = numeric(config.max_frames, 12, "video.max_frames", 1, MEDIA_LIMITS.maxFrames, true);
  const start = numeric(config.start_seconds, 0, "video.start_seconds", 0, duration - 0.001);
  const end = numeric(config.end_seconds, duration, "video.end_seconds", start + 0.001, duration);
  numeric(framePeriod, 0.1, "framePeriod", 0.0001, 3600);
  const last = Math.max(start, end - Math.min(Math.max(0.1, framePeriod * 1.1), end - start));
  const requested = last > start ? Math.ceil((last - start) * fps) + 1 : 1;
  const count = Math.min(requested, max, profileMax);
  // Um só frame observa o início. O EOF costuma ser posterior ao último PTS.
  const times = count === 1 ? [start] : Array.from({ length: count }, (_, i) => start + (last - start) * i / (count - 1));
  return { times: times.map((t) => Math.round(t * 1000) / 1000), start_seconds: start, end_seconds: end,
    requested_fps: fps, requested_frames: requested, sampled_frames: count, capped: count < requested,
    max_gap_seconds: count > 1 ? Math.round((last - start) / (count - 1) * 1000) / 1000 : null,
    effective_fps: count > 1 && last > start ? Math.round((count - 1) / (last - start) * 1000) / 1000 : 0,
    timestamp_basis: "requested_seek_seconds_not_exact_pts", continuous_coverage: false, audio_analyzed: false };
}

async function sourceFor(item, opts, temporary) {
  if (!item || !["image", "video"].includes(item.type)) throw new MediaError("Cada media[] exige type=image|video.");
  if (Boolean(item.path) === Boolean(item.data_url)) throw new MediaError("Forneça exatamente um path local ou data_url por mídia.");
  if (item.path) {
    if (typeof item.path !== "string" || /^(?:https?|file|data):/i.test(item.path)) throw new MediaError("Mídia deve ser um caminho local, não URL. Downloads ficam a cargo do projeto, com sua política de SSRF.");
    const absolute = await fs.realpath(path.resolve(opts.baseDir ?? process.cwd(), item.path));
    if (opts.mediaRoot) {
      const root = await fs.realpath(path.resolve(opts.mediaRoot));
      const relative = path.relative(root, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new MediaError("Mídia fora de mediaRoot; symlinks não escapam da raiz autorizada.");
    }
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MEDIA_LIMITS.maxInputBytes) throw new MediaError("Mídia deve ser ficheiro regular não vazio de até 256 MiB (teto local).");
    return { file: absolute, size: stat.size, name: path.basename(absolute), bytes: item.type === "image" ? await fs.readFile(absolute) : null };
  }
  const decoded = decodeDataUrl(item.data_url, { kind: item.type, maxBytes: MEDIA_LIMITS.maxInputBytes });
  const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm" };
  const ext = extensions[decoded.mime];
  if (!ext) throw new MediaError("Data URL aceita image/png, image/jpeg, image/webp, video/mp4 ou video/webm.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-media-"));
  temporary.push(dir);
  const file = path.join(dir, `input${ext}`);
  await fs.writeFile(file, decoded.bytes, { mode: 0o600 });
  return { file, size: decoded.bytes.length, name: `inline${ext}`, bytes: item.type === "image" ? decoded.bytes : null };
}

export async function probeVideo(file, opts = {}) {
  // Recusa playlists/concat, inclusive com extensão falsa: podem referenciar outros
  // ficheiros locais fora da mediaRoot. O decoder deve ainda ser isolado em produção.
  const handle = await fs.open(file, "r");
  const header = Buffer.alloc(16);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const containerOK = header.toString("ascii", 4, 8) === "ftyp" || header.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) || (header.toString("ascii",0,4) === "RIFF" && header.toString("ascii",8,12) === "AVI ");
  if (!containerOK) throw new MediaError("Vídeo exige container MP4/MOV, WebM/MKV ou AVI; playlists e URLs embutidos não são aceitos.");
  const raw = await run(opts.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi", "-show_streams", "-show_format", "-of", "json", file], { maxBuffer: MiB, timeoutMs: opts.mediaTimeoutMs });
  let data;
  try { data = JSON.parse(raw); } catch { throw new MediaError("FFprobe não devolveu JSON válido."); }
  const stream = data.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const duration = Number(stream?.duration ?? data.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new MediaError("Vídeo sem stream visual/duração finita; exporte um ficheiro completo antes de analisar.");
  const rotation = Number(stream.side_data_list?.find((d) => Number.isFinite(Number(d.rotation)))?.rotation ?? stream.tags?.rotate ?? 0);
  const swapped = Math.abs(rotation % 180) === 90;
  const rateParts = String(stream.avg_frame_rate ?? stream.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = rateParts.length === 2 ? rateParts[0] / rateParts[1] : rateParts[0];
  return { frame_rate: Number.isFinite(fps) && fps > 0 ? fps : null,
    width: Number(stream.width), height: Number(stream.height), oriented_width: Number(swapped ? stream.height : stream.width),
    oriented_height: Number(swapped ? stream.width : stream.height), rotation_degrees: rotation,
    duration_seconds: duration, has_audio: data.streams.some((s) => s.codec_type === "audio"), format: data.format?.format_name ?? null };
}

async function prepareImage(src, profile, opts) {
  let info;
  try { info = inspectImage(src.bytes); } catch (e) {
    // Outros formatos de FOTO precisam de conversão explícita pelo decoder.
    if (!/\.(?:webp|heic|heif|avif|bmp|tiff?)$/i.test(src.name)) throw new MediaError(e.message);
    const raw = await run(opts.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "stream=width,height", "-of", "json", src.file], { maxBuffer: MiB, timeoutMs: opts.mediaTimeoutMs });
    const s = JSON.parse(raw).streams?.[0];
    info = { width: Number(s?.width), height: Number(s?.height), orientation: 1, mime: "converted", animated: false };
  }
  if (info.animated) throw new MediaError("APNG/animação não é uma fotografia estática. Exporte frames ou use um ficheiro de vídeo.");
  const geometry = imageGeometry(info.width, info.height, { minAxis: profile.minImageAxis, maxAxis: profile.maxImageAxis, orientation: info.orientation });
  let bytes = src.bytes, metadataStripped = false;
  if (opts.preprocess !== false) {
    bytes = await run(opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-noautorotate", "-i", src.file,
      "-map", "0:v:0", "-frames:v", "1", "-vf", filters(geometry, { explicitOrientation: true }), "-map_metadata", "-1", "-an", "-threads", "1", "-c:v", "mjpeg", "-pix_fmt", "yuvj444p", "-q:v", "3", "-f", "image2pipe", "pipe:1"], { binary: true, maxBuffer: profile.maxImageBytes + MiB, timeoutMs: opts.mediaTimeoutMs });
    metadataStripped = true;
  }
  let actual;
  try { actual = inspectImage(bytes); } catch (e) { throw new MediaError(e.message); }
  if (actual.orientation !== 1 || actual.width !== geometry.prepared_width || actual.height !== geometry.prepared_height || actual.animated) {
    throw new MediaError("A imagem necessita de resize/padding/rotação física. Ative o pré-processamento com FFmpeg.");
  }
  if (bytes.length > profile.maxImageBytes) throw new MediaError("Imagem preparada excede o limite do adaptador; reduza resolução/qualidade.");
  return { part: { type: "image_url", image_url: { url: `data:${actual.mime};base64,${bytes.toString("base64")}` } },
    manifest: { type: "image", name: src.name, mime: actual.mime, bytes: bytes.length, geometry, metadata_stripped: metadataStripped } };
}

/** Devolve partes em state de TOPO: portátil entre os dois adaptadores suportados. */
export async function prepareMedia(items, profile, videoConfig = {}, opts = {}) {
  if (!Array.isArray(items) || items.length > MEDIA_LIMITS.maxItems) throw new MediaError("media deve ser array com até 16 entradas (teto local).");
  const mode = videoConfig.mode ?? "frames";
  if (!["frames", "native"].includes(mode)) throw new MediaError("video.mode deve ser frames ou native. Não trocamos silenciosamente o modelo.");
  if (mode === "native" && !profile.input.includes("video") && items.some((m) => m.type === "video")) throw new MediaError("Este modelo não aceita vídeo nativo. Use frames com Jev ou native com cloudflare/clef-omni.");
  const temporary = [], parts = [], manifest = [], ids = new Set();
  let images = 0, videos = 0, avBytes = 0;
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i], id = item?.id ?? `media_${i + 1}`;
      if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || ids.has(id)) throw new MediaError("Cada id de mídia deve ser único, ASCII (letra inicial), até 64 caracteres.");
      ids.add(id);
      const src = await sourceFor(item, opts, temporary);
      if (item.type === "image") {
        if (++images > profile.maxImages) throw new MediaError(`Adaptador permite até ${profile.maxImages} imagens; reduza media/frames.`);
        const prepared = await prepareImage(src, profile, opts);
        parts.push(JSON.stringify({ media_id: id, kind: "image" }), prepared.part);
        manifest.push({ id, ...prepared.manifest });
        continue;
      }
      const probe = await probeVideo(src.file, opts);
      if (probe.width * probe.height > MEDIA_LIMITS.maxPixels) throw new MediaError("Vídeo acima de 80 MP por frame (teto local).");
      if (mode === "native") {
        if (++videos > profile.maxVideos || src.size > profile.maxVideoBytes || probe.duration_seconds > profile.maxVideoSeconds) throw new MediaError(`Vídeo nativo: até ${profile.maxVideos} clipes, ${profile.maxVideoSeconds}s e ${profile.maxVideoBytes / MiB}MiB cada. Use frames ou corte/comprima explicitamente.`);
        if (videoConfig.start_seconds !== undefined || videoConfig.end_seconds !== undefined || videoConfig.fps !== undefined || videoConfig.max_frames !== undefined) throw new MediaError("Recorte/fps/max_frames são opções do modo frames. No modo native envie um clipe já cortado; o provider amostra a 2fps.");
        const ext = path.extname(src.name).toLowerCase();
        if (![".mp4", ".webm"].includes(ext)) throw new MediaError("Modo native aceita MP4/WebM verificados; converta MOV e outros containers explicitamente.");
        const bytes = await fs.readFile(src.file);
        const signatureOK = ext === ".mp4" ? bytes.toString("ascii", 4, 8) === "ftyp" : bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
        if (!signatureOK || bytes.length > profile.maxVideoBytes) throw new MediaError("Container não corresponde ao tipo/tamanho declarado.");
        avBytes += bytes.length;
        if (avBytes > profile.maxAVBytes) throw new MediaError("Soma dos vídeos excede 16MiB decoded; nenhum upload foi feito.");
        const mime = ext === ".mp4" ? "video/mp4" : "video/webm";
        parts.push(JSON.stringify({ media_id: id, kind: "video", duration_seconds: probe.duration_seconds }), { type: "video_url", video_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } });
        manifest.push({ id, type: "video", mode, name: src.name, mime, bytes: bytes.length, ...probe,
          sampling_fps: profile.videoFps, continuous_coverage: false, audio_analyzed: "provider-dependent; not guaranteed", audio_included: probe.has_audio });
      } else {
        const remaining = profile.maxImages - images;
        if (remaining < 1) throw new MediaError("Sem espaço para frames adicionais neste adaptador; reduza as mídias ou use pedidos separados.");
        const sampling = planVideoSamples(probe.duration_seconds, videoConfig, remaining, probe.frame_rate ? 1 / probe.frame_rate : 0.5);
        const g = imageGeometry(probe.oriented_width, probe.oriented_height, { minAxis: profile.minImageAxis, maxAxis: profile.maxImageAxis });
        const frames = [];
        for (let f = 0; f < sampling.times.length; f++) {
          const seconds = sampling.times[f];
          const bytes = await run(opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-ss", String(seconds), "-i", src.file,
            "-map", "0:v:0", "-frames:v", "1", "-vf", filters(g), "-map_metadata", "-1", "-an", "-threads", "1", "-c:v", "mjpeg", "-pix_fmt", "yuvj444p", "-q:v", "3", "-f", "image2pipe", "pipe:1"], { binary: true, maxBuffer: profile.maxImageBytes + MiB, timeoutMs: opts.mediaTimeoutMs });
          const frameInfo = inspectImage(bytes);
          if (bytes.length > profile.maxImageBytes || frameInfo.width !== g.prepared_width || frameInfo.height !== g.prepared_height) throw new MediaError("Frame inválido após conversão.");
          const frameId = `${id}_frame_${f + 1}`;
          parts.push(JSON.stringify({ media_id: id, frame_id: frameId, requested_seconds: seconds }), { type: "image_url", image_url: { url: `data:image/jpeg;base64,${bytes.toString("base64")}` } });
          frames.push({ id: frameId, requested_seconds: seconds, bytes: bytes.length });
          images++;
        }
        manifest.push({ id, type: "video", mode, name: src.name, ...probe, sampling, geometry: g, frames });
      }
    }
    return { parts, manifest, counts: { images, videos }, mode };
  } finally {
    for (const dir of temporary) {
      // Só remove diretórios criados por mkdtemp neste processo, no pai esperado.
      const absolute = path.resolve(dir);
      if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith("jev-media-")) throw new Error("Recusada limpeza de caminho temporário inesperado.");
      await fs.rm(absolute, { recursive: true, force: true });
    }
  }
}
