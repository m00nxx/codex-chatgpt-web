import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CHATGPT_CONTEXT_SPOOL_CHUNK_CHARS,
  MAX_CHATGPT_CONTEXT_SPOOL_CHUNKS,
  chatGptContextSpoolChunkPayload,
  compileChatGptContextSpoolBootstrap,
  createChatGptContextSpool,
  selectChatGptContextSpool,
} from "../src/adapters/chatgpt-web/context-spool";
import type { CompiledChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";

const plus = { localToolsEnabled: true, solAvailable: true, proAvailable: false };
const turnToken = `turn_${"a".repeat(32)}`;

function compiled(text: string): CompiledChatGptWebPrompt {
  return { text, images: [] };
}

test("context spool reconstructs exact UTF-16 text with a verified hash chain", () => {
  const text = `${"a".repeat(CHATGPT_CONTEXT_SPOOL_CHUNK_CHARS - 1)}😀tail`;
  const spool = createChatGptContextSpool(text);

  expect(spool.chunks).toHaveLength(2);
  expect(spool.chunks.map(chunk => chunk.text).join("")).toBe(text);
  expect(spool.rootDigest).toBe(createHash("sha256").update(text).digest("hex"));
  expect(spool.chunks[0]?.text.endsWith("\ud83d")).toBe(false);
  expect(spool.chunks[1]?.text.startsWith("😀")).toBe(true);
  expect(spool.chunks[1]?.previousDigest).toBe(spool.chunks[0]?.digest);

  const payload = chatGptContextSpoolChunkPayload(spool, 1);
  expect(payload).toMatchObject({
    index: 1,
    next_cursor: 2,
    complete: false,
    root_digest: spool.rootDigest,
    chunk: "😀tail",
  });
});

test("transport-only overflow selects a small tool-bound bootstrap without inline context", () => {
  const original = " ".repeat(220_000);
  const selection = selectChatGptContextSpool(
    compiled(original),
    turnToken,
    "gpt-5.6-sol",
    "low",
    plus,
  );

  expect(selection.reason).toBe("selected");
  expect(selection.spool).toBeDefined();
  expect(selection.prepared.text.length).toBeLessThan(10_000);
  expect(selection.prepared.text).toContain("codex_context_next");
  expect(selection.prepared.text).toContain(turnToken);
  expect(selection.prepared.text).toContain(selection.spool!.rootDigest);
  expect(selection.prepared.text).not.toContain(" ".repeat(1_000));
  expect(selection.spool!.chunks.map(chunk => chunk.text).join("")).toBe(original);
  expect(selection.aggregateInputTokens).toBeLessThan(41_000);
});

test("context spool never bypasses the underlying model context window", () => {
  const original = "0123456789abcdef".repeat(14_000);
  const selection = selectChatGptContextSpool(
    compiled(original),
    turnToken,
    "gpt-5.6-sol",
    "low",
    plus,
  );

  expect(["model_context_exceeded", "spool_overhead_exceeds_context"]).toContain(selection.reason);
  expect(selection.spool).toBeUndefined();
  expect(selection.prepared.text).toBe(original);
});

test("top-level delta selection is delegated and unbounded spools remain fail-closed", () => {
  const delta: CompiledChatGptWebPrompt = {
    text: " ".repeat(220_000),
    images: [],
    continuum: {
      taskKey: "b".repeat(64),
      plannedMode: "delta",
      reason: "acknowledged_prefix",
      marker: '<codex_continuum_state version="1" />',
    },
  };
  expect(selectChatGptContextSpool(delta, turnToken, "gpt-5.6-sol", "low", plus).reason)
    .toBe("delta_requires_browser_verification");

  const tooLarge = " ".repeat(
    CHATGPT_CONTEXT_SPOOL_CHUNK_CHARS * MAX_CHATGPT_CONTEXT_SPOOL_CHUNKS + 1,
  );
  expect(selectChatGptContextSpool(
    compiled(tooLarge),
    turnToken,
    "gpt-5.6-sol",
    "low",
    plus,
  ).reason).toBe("spool_too_large");
});

test("bootstrap preserves the Continuum transcript marker", () => {
  const spool = createChatGptContextSpool("authoritative context");
  const marker = '<codex_continuum_state version="1" task="abc" />';
  const bootstrap = compileChatGptContextSpoolBootstrap(turnToken, spool, marker);
  expect(bootstrap).toContain(marker);
  expect(bootstrap).not.toContain("authoritative context");
  const contextOnly = compileChatGptContextSpoolBootstrap(turnToken, spool, marker, {
    contextOnlyToken: true,
  });
  expect(contextOnly).toContain("restricted to codex_context_next");
  expect(contextOnly).toContain("separate current turn_token");
});
