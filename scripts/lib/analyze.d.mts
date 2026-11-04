/** Backend Node >=20. Do not import into a client/browser bundle. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Guidance = string | Json[] | { [key: string]: Json };
export type Question =
  | { type: "noul"; instructions: Guidance; criteria?: { true: Guidance | null; false: Guidance | null } }
  | { type: "choice"; instructions: Guidance; criteria: Record<string, Guidance | null> }
  | { type: "score"; instructions: Guidance; criteria: (Guidance | null)[] }
  | { type: "box"; instructions: Guidance };
export type MediaSource = { id?: string; type: "image" | "video" } &
  ({ path: string; data_url?: never } | { data_url: string; path?: never });
export interface AnalysisSpec {
  model?: string;
  state?: string | Json[] | { [key: string]: Json };
  questions: Record<string, Question>;
  media?: MediaSource[];
  video?: { mode?: "frames" | "native"; fps?: number; max_frames?: number; start_seconds?: number; end_seconds?: number };
  box_presence?: Record<string, string>;
  provider?: Record<string, Json>;
  session_id?: string;
  user?: string;
  trace?: Record<string, Json>;
  assets?: Record<string, { type?: "image"; format: "png" | "jpg" | "jpeg"; data_base64: string }>;
}
export type Band = "auto" | "hitl" | "abstain";
export interface Decision {
  value: Json;
  band: Band;
  basis?: string;
  certainty?: number;
  confidence?: number | null;
  reason?: string;
  authorization?: false;
  localization_status?: string;
}
export interface Diagnostic { code: string; msg: string; where?: string }
export interface AnalysisResult {
  ok: boolean;
  dry_run?: boolean;
  model: string;
  media: Record<string, unknown>[];
  answers?: Record<string, Json>;
  decisions?: Record<string, Decision>;
  validation: { errors: Diagnostic[]; warnings: Diagnostic[]; info: Diagnostic[]; budget?: Record<string, unknown> };
  analysis: { kind: string; findings: Record<string, unknown>[]; narrative_source: "deterministic_local_templates"; limitations: string[] };
  usage?: { input_tokens: number; output_tokens: number; cost?: number } | null;
  safety: { advisory_only: true; executes_actions: false; visual_auto_disabled: boolean };
  model_verification: Record<string, unknown>;
  request_summary?: Record<string, unknown>;
  _som?: Record<string, unknown>;
  /** Legacy alias of _som; never count the cost twice. */
  _jev?: Record<string, unknown>;
}
export interface AnalysisOptions {
  apiKey?: string;
  env?: Record<string, string | undefined>;
  model?: string;
  dryRun?: boolean;
  strict?: boolean;
  mediaRoot?: string;
  baseDir?: string;
  preprocess?: boolean;
  thresholds?: { auto?: number; hitl?: number };
  retries?: number;
  timeoutMs?: number;
  catalogTimeoutMs?: number;
  mediaTimeoutMs?: number;
  maxRetryWaitMs?: number;
  checkModel?: boolean;
  endpoint?: "https://openrouter.ai/api/alpha/decisions" | "https://openrouter.ai/api/v1/systemone";
  ffmpegPath?: string;
  ffprobePath?: string;
}
export class AnalysisError extends Error { readonly exitCode: 2; readonly validation: unknown }
export function analyze(spec: AnalysisSpec, opts?: AnalysisOptions): Promise<AnalysisResult>;
/** Contains request bytes/base64. Never log or persist the returned wire payload. */
export function prepareAnalysis(spec: AnalysisSpec, opts?: AnalysisOptions): Promise<{
  request: { model: string; state: unknown; questions: Record<string, Question>; [key: string]: unknown };
  validation: unknown;
  media: Record<string, unknown>[];
  visual: boolean;
  boxPresence: Record<string, string>;
  modalities: string[];
}>;
export function renderAnalysis(result: AnalysisResult): string;
export function describeAnswers(request: { questions: Record<string, Question> }, answers: Record<string, Json>, decisions: Record<string, Decision>, media?: Record<string, unknown>[]): AnalysisResult["analysis"];
/** Call at process shutdown, not between requests in a resident backend. */
export function closeAgents(): void;
