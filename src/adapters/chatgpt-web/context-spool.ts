import { createHash } from "node:crypto";
import {
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
  type ChatGptWebBackendModel,
} from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import {
  estimateCompiledChatGptWebInputTokens,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import type { ChatGptWebCapabilities, ChatGptWebModelMode } from "./model";
import type { CompiledChatGptWebPrompt } from "./prompt";

export const CHATGPT_CONTEXT_SPOOL_CHUNK_CHARS = 65_536;
export const MAX_CHATGPT_CONTEXT_SPOOL_CHUNKS = 32;
const CHATGPT_CONTEXT_SPOOL_TOOL_CALL_RESERVE_TOKENS = 256;
const ZERO_DIGEST = "0".repeat(64);

export interface ChatGptContextSpoolChunk {
  index: number;
  previousDigest: string;
  digest: string;
  text: string;
}

export interface ChatGptContextSpool {
  version: 1;
  rootDigest: string;
  chunks: ChatGptContextSpoolChunk[];
}

export interface ChatGptContextSpoolChunkPayload {
  version: 1;
  root_digest: string;
  total_chunks: number;
  index: number;
  previous_digest: string;
  chunk_digest: string;
  chunk: string;
  next_cursor: number;
  complete: false;
}

export interface ChatGptContextSpoolCompletePayload {
  version: 1;
  root_digest: string;
  total_chunks: number;
  next_cursor: number;
  complete: true;
}

export type ChatGptContextSpoolPayload =
  | ChatGptContextSpoolChunkPayload
  | ChatGptContextSpoolCompletePayload;

export interface ChatGptContextSpoolSelection {
  prepared: CompiledChatGptWebPrompt;
  spool?: ChatGptContextSpool;
  reason:
    | "selected"
    | "not_needed"
    | "delta_requires_browser_verification"
    | "model_context_exceeded"
    | "spool_too_large"
    | "spool_overhead_exceeds_context"
    | "bootstrap_exceeds_transport";
  aggregateInputTokens?: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function chunkDigest(previousDigest: string, index: number, text: string): string {
  return createHash("sha256")
    .update("codex-context-spool/v1\0", "utf8")
    .update(previousDigest, "ascii")
    .update("\0", "utf8")
    .update(String(index), "ascii")
    .update("\0", "utf8")
    .update(text, "utf8")
    .digest("hex");
}

function safeChunkEnd(text: string, offset: number): number {
  let end = Math.min(offset + CHATGPT_CONTEXT_SPOOL_CHUNK_CHARS, text.length);
  if (end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
    end -= 1;
  }
  return end;
}

export function createChatGptContextSpool(text: string): ChatGptContextSpool {
  if (!text) throw new Error("ChatGPT context spool cannot be empty");
  const chunks: ChatGptContextSpoolChunk[] = [];
  let previousDigest = ZERO_DIGEST;
  for (let offset = 0; offset < text.length;) {
    if (chunks.length >= MAX_CHATGPT_CONTEXT_SPOOL_CHUNKS) {
      throw new Error(
        `ChatGPT context spool requires more than ${MAX_CHATGPT_CONTEXT_SPOOL_CHUNKS} chunks`,
      );
    }
    const end = safeChunkEnd(text, offset);
    const chunkText = text.slice(offset, end);
    const digest = chunkDigest(previousDigest, chunks.length, chunkText);
    chunks.push({ index: chunks.length, previousDigest, digest, text: chunkText });
    previousDigest = digest;
    offset = end;
  }
  return { version: 1, rootDigest: sha256(text), chunks };
}

export function chatGptContextSpoolChunkPayload(
  spool: ChatGptContextSpool,
  index: number,
): ChatGptContextSpoolChunkPayload {
  const chunk = spool.chunks[index];
  if (!chunk) throw new Error(`ChatGPT context spool chunk is unavailable: ${index}`);
  return {
    version: 1,
    root_digest: spool.rootDigest,
    total_chunks: spool.chunks.length,
    index: chunk.index,
    previous_digest: chunk.previousDigest,
    chunk_digest: chunk.digest,
    chunk: chunk.text,
    next_cursor: chunk.index + 1,
    complete: false,
  };
}

export function chatGptContextSpoolCompletePayload(
  spool: ChatGptContextSpool,
): ChatGptContextSpoolCompletePayload {
  return {
    version: 1,
    root_digest: spool.rootDigest,
    total_chunks: spool.chunks.length,
    next_cursor: spool.chunks.length,
    complete: true,
  };
}

export function compileChatGptContextSpoolBootstrap(
  turnToken: string,
  spool: ChatGptContextSpool,
  continuumMarker?: string,
): string {
  const finalCursor = spool.chunks.length;
  return [
    '<codex_context_spool version="1">',
    "This is a fail-closed transport bootstrap for one ChatGPT Web response.",
    "The authoritative Codex transport prompt is held by the read-only Codex Native context tool; it is not present inline here.",
    `turn_token: ${turnToken}`,
    `root_digest: ${spool.rootDigest}`,
    `total_chunks: ${finalCursor}`,
    `chunk_char_limit: ${CHATGPT_CONTEXT_SPOOL_CHUNK_CHARS}`,
    "Mandatory protocol:",
    `1. Before reasoning about the task, answering, or calling any other tool, call codex_context_next with turn_token ${turnToken} and cursor 0.`,
    "2. Follow each returned next_cursor exactly. Preserve every returned chunk field verbatim and in index order. Do not summarize, omit, normalize, or reorder it.",
    `3. After receiving chunk index ${finalCursor - 1}, call codex_context_next once more with cursor ${finalCursor} and acknowledged_root_digest ${spool.rootDigest}.`,
    "4. Continue only after that call returns complete=true with the same root_digest and total_chunks.",
    "5. Concatenate the chunk fields exactly. Treat the reconstruction as the complete authoritative transport message and execute its contracts as though it had been this user message.",
    "6. If a chunk, cursor, digest, or completion call fails or disagrees, stop fail-closed without answering and without calling another tool.",
    "Do not expose the reconstructed transport envelope in the final answer.",
    ...(continuumMarker ? ["Continuum transcript marker (preserve exactly):", continuumMarker] : []),
    "</codex_context_spool>",
  ].join("\n");
}

function spoolAggregateInputTokens(
  compiled: CompiledChatGptWebPrompt,
  bootstrap: string,
  spool: ChatGptContextSpool,
  modelId: ChatGptWebBackendModel,
): number {
  const originalInputTokens = estimateCompiledChatGptWebInputTokens(compiled, modelId);
  const originalMessageTokens = estimateCompiledChatGptWebMessageTokens(compiled, modelId);
  const nonMessageTokens = Math.max(
    CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
    originalInputTokens - originalMessageTokens,
  );
  const chunkTokens = spool.chunks.reduce((total, chunk) => (
    total
    + estimateTokens(JSON.stringify(chatGptContextSpoolChunkPayload(spool, chunk.index)), modelId)
    + CHATGPT_CONTEXT_SPOOL_TOOL_CALL_RESERVE_TOKENS
  ), 0);
  const completionTokens = estimateTokens(
    JSON.stringify(chatGptContextSpoolCompletePayload(spool)),
    modelId,
  ) + CHATGPT_CONTEXT_SPOOL_TOOL_CALL_RESERVE_TOKENS;
  return nonMessageTokens
    + estimateTokens(bootstrap, modelId)
    + chunkTokens
    + completionTokens;
}

/**
 * Select a context spool only for a full, tool-capable prompt that exceeds a measured one-message
 * transport boundary while still fitting the underlying model context after conservative tool
 * result overhead. A delta must first be selected against the retained browser transcript, so the
 * prototype deliberately leaves delta fallback handling to the existing fail-closed preflight.
 */
export function selectChatGptContextSpool(
  compiled: CompiledChatGptWebPrompt,
  turnToken: string,
  modelId: ChatGptWebBackendModel,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
): ChatGptContextSpoolSelection {
  if (compiled.continuum?.plannedMode === "delta") {
    return { prepared: compiled, reason: "delta_requires_browser_verification" };
  }
  const transport = resolveChatGptWebTransportLimits(modelId, effort, capabilities);
  const exceedsComposer = (
    transport.browserComposerCharLimit !== undefined
    && compiled.text.length > transport.browserComposerCharLimit
  );
  const messageTokens = exceedsComposer || transport.browserMessageTokenLimit === undefined
    ? undefined
    : estimateCompiledChatGptWebMessageTokens(compiled, modelId);
  const exceedsTransport = exceedsComposer || (
    transport.browserMessageTokenLimit !== undefined
    && messageTokens !== undefined
    && messageTokens > transport.browserMessageTokenLimit
  );
  if (!exceedsTransport) return { prepared: compiled, reason: "not_needed" };
  if (compiled.text.length > CHATGPT_CONTEXT_SPOOL_CHUNK_CHARS * MAX_CHATGPT_CONTEXT_SPOOL_CHUNKS) {
    return { prepared: compiled, reason: "spool_too_large" };
  }

  const { contextWindow } = resolveChatGptWebContextLimits(modelId, effort, capabilities);
  const inputTokens = estimateCompiledChatGptWebInputTokens(compiled, modelId);
  if (inputTokens >= contextWindow) {
    return { prepared: compiled, reason: "model_context_exceeded" };
  }

  let spool: ChatGptContextSpool;
  try {
    spool = createChatGptContextSpool(compiled.text);
  } catch (error) {
    if (error instanceof Error && error.message.includes("more than")) {
      return { prepared: compiled, reason: "spool_too_large" };
    }
    throw error;
  }
  const bootstrap = compileChatGptContextSpoolBootstrap(
    turnToken,
    spool,
    compiled.continuum?.marker,
  );
  const bootstrapTokens = estimateTokens(bootstrap, modelId);
  if ((transport.browserComposerCharLimit !== undefined
      && bootstrap.length > transport.browserComposerCharLimit)
    || (transport.browserMessageTokenLimit !== undefined
      && bootstrapTokens > transport.browserMessageTokenLimit)) {
    return { prepared: compiled, reason: "bootstrap_exceeds_transport" };
  }
  const aggregateInputTokens = spoolAggregateInputTokens(compiled, bootstrap, spool, modelId);
  if (aggregateInputTokens >= contextWindow) {
    return {
      prepared: compiled,
      reason: "spool_overhead_exceeds_context",
      aggregateInputTokens,
    };
  }
  return {
    prepared: { ...compiled, text: bootstrap },
    spool,
    reason: "selected",
    aggregateInputTokens,
  };
}
