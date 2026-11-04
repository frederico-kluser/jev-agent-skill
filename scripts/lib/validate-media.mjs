import { profileFor } from "./capabilities.mjs";
import { collectMedia, decodeDataUrl, inspectImage, withoutMediaData, MiB } from "./media-info.mjs";

/** Acrescenta validações à mesma Report da requisição; nunca faz I/O nem rede. */
export function validateRequestMedia(req, report) {
  const profile = profileFor(req.model);
  let body;
  try { body = JSON.stringify(req); } catch {
    report.err("request.serializable", "Pedido deve ser JSON serializável, sem ciclos ou BigInt.");
    return { profile, hasMedia: false, images: 0, videos: 0, stateForTokens: "", questionsForTokens: {}, bodyBytes: 0 };
  }
  const inspectPartShape = (value, where) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const payloads = ["image_url", "video_url", "input_audio"].filter((key) => Object.hasOwn(value, key) && value[key] && typeof value[key] === "object");
      if (["input_image", "input_video"].includes(value.type) || (payloads.length && (payloads.length !== 1 || value.type !== payloads[0]))) {
        report.err("media.part_type", "Envelope de mídia incompleto/tipo incorreto; use image_url, video_url ou input_audio exatos, não um objeto de chat/Responses ou um typo enviado como texto.", where);
      }
    }
    for (const [key, child] of Object.entries(value)) inspectPartShape(child, Array.isArray(value) ? `${where}[${key}]` : `${where}.${key}`);
  };
  inspectPartShape(req.state, "state");
  inspectPartShape(req.questions, "questions");
  const entries = [...collectMedia(req.state, "state"), ...collectMedia(req.questions, "questions")];
  const assets = req.assets;
  let assetCount = 0, imageBytes = 0, expandedBytes = 0, avBytes = 0;
  if (assets !== undefined) {
    if (!assets || typeof assets !== "object" || Array.isArray(assets)) report.err("assets.type", "assets deve ser mapa de referências de imagem.", "assets");
    else {
      let referenceBytes = 0;
      const strings = [];
      const stringValues = (value) => {
        if (typeof value === "string") strings.push(value);
        else if (value && typeof value === "object") for (const child of Object.values(value)) stringValues(child);
      };
      stringValues(req.state);
      for (const q of Object.values(req.questions ?? {})) { stringValues(q?.instructions); stringValues(q?.criteria); }
      for (const [ref, asset] of Object.entries(assets)) {
        assetCount++;
        referenceBytes += Buffer.byteLength(ref);
        const where = `assets.${ref}`;
        if (!ref || Buffer.byteLength(ref) > 1024) report.err("assets.reference", "Referência deve ter 1..1024 bytes UTF-8.", where);
        const uses = ref ? strings.reduce((count, text) => count + text.split(ref).length - 1, 0) : 0;
        if (!uses) report.err("assets.unused", "Toda referência de assets deve ser usada em state/questions.", where);
        if (profile?.adapter !== "typesafe") report.err("assets.adapter", "assets/referências são suportados aqui só no adaptador Jev; use image_url no state de topo.", where);
        if (!asset || (asset.type !== undefined && asset.type !== "image") || !["png", "jpg", "jpeg"].includes(asset.format) || typeof asset.data_base64 !== "string" || "part" in asset) {
          report.err("assets.image", "Asset OpenRouter exige type=image, format=png|jpg|jpeg e data_base64; multipart part não é aceito.", where);
          continue;
        }
        const mime = asset.format === "png" ? "image/png" : "image/jpeg";
        entries.push({ kind: "image", where, uses, value: { type: "image_url", image_url: { url: `data:${mime};base64,${asset.data_base64}` } } });
      }
      if (referenceBytes > 65_536) report.err("assets.references_size", "Referências de assets excedem 65536 bytes.", "assets");
    }
  }
  const hasMedia = entries.length > 0 || assetCount > 0;
  if (hasMedia && !profile) report.err("media.profile", "Sem perfil de adaptador verificado para este modelo. Use Jev 1.13/1.14 ou Clef Omni; não inferimos limites só pelo nome.", "model");
  const bodyLimit = profile?.maxBodyBytes ?? 32 * MiB;
  if (Buffer.byteLength(body) > bodyLimit) report.err("media.body_bytes", `JSON/base64 excede ${bodyLimit / MiB} MiB; reduza mídias/state.`, "request");
  let images = 0, videos = 0;
  for (const entry of entries) {
    const { kind, value, where } = entry;
    if (!profile) continue;
    if (!profile.input.includes(kind)) { report.err("media.unsupported", `${req.model} não ingere ${kind} nativamente. Vídeo com Jev exige frames.`, where); continue; }
    if (profile.topLevelMedia && !/^state\[\d+\]$/.test(where)) report.err("media.position", "Este adaptador só lê mídia diretamente no array state de topo.", where);
    if (kind === "audio") { report.err("media.audio_scope", "A CLI desta skill não valida áudio isolado. Use vídeo nativo ou uma integração de áudio própria, sem serializar bytes como texto.", where); continue; }
    try {
      const url = kind === "image" ? value.image_url?.url : value.video_url?.url;
      const { bytes, mime } = decodeDataUrl(url, { kind, maxBytes: kind === "image" ? profile.maxImageBytes : profile.maxVideoBytes });
      if (kind === "image") {
        images++;
        const info = inspectImage(bytes);
        if (mime !== info.mime) throw new Error("MIME declarado não corresponde aos bytes da imagem.");
        if (info.animated) throw new Error("APNG/animações não são aceitos como imagens estáticas.");
        if (info.orientation !== 1) throw new Error("EXIF de orientação não aplicado fisicamente. Use analyze para pré-processar.");
        if (Math.min(info.width, info.height) < profile.minImageAxis || Math.max(info.width, info.height) > profile.maxImageAxis) throw new Error(`Dimensões exigidas pelo perfil local: ${profile.minImageAxis}..${profile.maxImageAxis}px por eixo; use analyze para resize/padding.`);
        imageBytes += bytes.length;
        expandedBytes += bytes.length * (entry.uses ?? 1);
      } else {
        videos++;
        if (!["video/mp4", "video/webm"].includes(mime)) throw new Error("Vídeo nativo validado: somente MP4/WebM.");
        const valid = mime === "video/mp4" ? bytes.toString("ascii", 4, 8) === "ftyp" : bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
        if (!valid) throw new Error("Assinatura do container de vídeo inválida.");
        avBytes += bytes.length;
      }
    } catch (e) { report.err(`media.${kind}`, e.message, where); }
  }
  if (profile) {
    if (images > profile.maxImages) report.err("media.image_count", `Mais de ${profile.maxImages} imagens (teto do perfil; Jev64 é limite local).`, "state");
    const expandedTextBytes = Buffer.byteLength(JSON.stringify(withoutMediaData(req)));
    if (imageBytes > profile.maxImageTotalBytes || (expandedBytes > 0 && expandedBytes + expandedTextBytes > profile.maxImageTotalBytes)) report.err("media.image_total_bytes", "Imagens distintas ou referências expandidas excedem o teto do adaptador.", "state");
    if (videos > (profile.maxVideos ?? 0)) report.err("media.video_count", "Quantidade de vídeos excede o teto do adaptador.", "state");
    if (avBytes > (profile.maxAVBytes ?? 0)) report.err("media.av_bytes", "Áudio+vídeo excede 16MiB decoded por pedido.", "state");
    if (profile.maxQuestions && Object.keys(req.questions ?? {}).length > profile.maxQuestions) report.err("questions.adapter_count", `Este adaptador aceita até ${profile.maxQuestions} perguntas.`, "questions");
    if (images && profile.experimentalImages) report.warn("media.experimental", "Imagens/box do Jev são Dreamer-ready (experimentais) e ativam long-context. Valide no seu domínio; latência/calibração textual não se transferem.", "state");
    if (videos) report.note("media.video_sampling", "Vídeo nativo é amostrado a 2fps; duração/codecs são conferidos por FFprobe no analyze, não por este validador de envelope.", "state");
  }
  if (hasMedia) report.note("budget.visual_unknown", "Base64 não é contado como texto. Tokens visuais/áudio dependem do provider; a estimativa offline NÃO garante caber no contexto.", "state");
  const mediaContext = profile?.imageContext ?? profile?.context;
  return { hasMedia, images, videos, profile,
    stateForTokens: withoutMediaData(req.state), questionsForTokens: withoutMediaData(req.questions),
    totalLimit: hasMedia ? mediaContext : profile?.context,
    questionLimit: hasMedia ? mediaContext : profile?.questionContext,
    bodyBytes: Buffer.byteLength(body) };
}
