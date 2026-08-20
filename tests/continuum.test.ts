import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptContinuumStore,
  chatGptContinuumContextDigest,
} from "../src/adapters/chatgpt-web/continuum";
import {
  compileChatGptWebPrompt,
  withoutSupersededModelSwitchContracts,
} from "../src/adapters/chatgpt-web/prompt";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

function parsed(
  threadId: string,
  turnId: string,
  messages: CodexMessage[],
  systemPrompt = ["system-contract"],
): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    context: { systemPrompt, messages },
    stream: true,
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
    },
  };
}

function user(text: string, timestamp = 1): CodexMessage {
  return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp = 2): CodexMessage {
  return {
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "text", text }],
    timestamp,
  };
}

describe("ChatGPT Continuum acknowledged-prefix ledger", () => {
  test("the first task turn is full and persistence contains only digests", () => {
    const directory = mkdtempSync(join(tmpdir(), "cgw-continuum-first-"));
    try {
      const path = join(directory, "continuum.json");
      const store = new ChatGptContinuumStore(path, "provider-a", () => 100);
      const request = parsed("thread-first-secret", "turn-1", [user("sensitive first request")]);
      const plan = store.plan(request, request.context.messages);

      expect(plan.mode).toBe("full");
      expect(plan.reason).toBe("new_task");
      expect(plan.marker).not.toContain("thread-first-secret");
      store.commit(plan, "sensitive first answer");

      const persisted = readFileSync(path, "utf8");
      expect(persisted).not.toContain("sensitive first request");
      expect(persisted).not.toContain("sensitive first answer");
      expect(persisted).not.toContain("thread-first-secret");
      expect(JSON.parse(persisted).version).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a proven next turn sends only the new ordered delta", () => {
    const store = new ChatGptContinuumStore(undefined, "provider-b");
    const first = parsed("thread-delta", "turn-1", [user("first")]);
    const firstPlan = store.plan(first, first.context.messages);
    store.commit(firstPlan, "answer-one");

    const messages = [user("first"), assistant("answer-one"), user("second", 3)];
    const second = parsed("thread-delta", "turn-2", messages);
    const plan = store.plan(second, messages);

    expect(plan.mode).toBe("delta");
    expect(plan.reason).toBe("acknowledged_prefix");
    expect(plan.system).toEqual([]);
    expect(plan.messages).toEqual([messages[2]!]);
    expect(plan.expectedPreviousMarker).toBe(firstPlan.marker);

    const compiled = compileChatGptWebPrompt(
      second,
      { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      undefined,
      { continuumPlan: plan },
    );
    const encoded = /<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/.exec(compiled.text)?.[1];
    const envelope = JSON.parse(encoded!) as {
      version: number;
      continuum: { mode: string; acknowledged_prefix_digest: string };
      system: string[];
      messages: Array<{ role: string; content: string }>;
    };
    expect(envelope.version).toBe(4);
    expect(envelope.continuum.mode).toBe("delta");
    expect(envelope.continuum.acknowledged_prefix_digest).toBe(firstPlan.contextDigest);
    expect(envelope.system).toEqual([]);
    expect(envelope.messages).toEqual([{ role: "user", content: "second" }]);
    expect(compiled.continuum?.fullFallback?.text).toContain("answer-one");
  });

  test("tool calls and results already consumed in one browser response stay out of the next delta", () => {
    const store = new ChatGptContinuumStore(undefined, "provider-tools");
    const first = parsed("thread-tools", "turn-1", [user("inspect")]);
    store.commit(store.plan(first, first.context.messages), "inspection complete");
    const messages: CodexMessage[] = [
      user("inspect"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "exec_command", arguments: { cmd: "pwd" } }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec_command",
        content: "C:\\workspace",
        isError: false,
        timestamp: 3,
      },
      assistant("inspection complete", 4),
      user("continue", 5),
    ];
    const next = parsed("thread-tools", "turn-2", messages);
    const plan = store.plan(next, messages);

    expect(plan.mode).toBe("delta");
    expect(plan.messages).toEqual([messages.at(-1)!]);
  });

  test("new images are attached in the delta while the full reset fallback retains all images", () => {
    const oldImage = "data:image/png;base64,aGVsbG8=";
    const newImage = "data:image/png;base64,d29ybGQ=";
    const store = new ChatGptContinuumStore(undefined, "provider-images");
    const firstMessages: CodexMessage[] = [{
      role: "user",
      content: [{ type: "text", text: "old" }, { type: "image", imageUrl: oldImage }],
      timestamp: 1,
    }];
    const first = parsed("thread-images", "turn-1", firstMessages);
    store.commit(store.plan(first, firstMessages), "seen");
    const nextMessages: CodexMessage[] = [
      ...firstMessages,
      assistant("seen"),
      {
        role: "user",
        content: [{ type: "text", text: "new" }, { type: "image", imageUrl: newImage }],
        timestamp: 3,
      },
    ];
    const next = parsed("thread-images", "turn-2", nextMessages);
    const plan = store.plan(next, nextMessages);
    const compiled = compileChatGptWebPrompt(
      next,
      { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      undefined,
      { continuumPlan: plan },
    );

    expect(compiled.images.map(image => image.imageUrl)).toEqual([newImage]);
    expect(compiled.continuum?.fullFallback?.images.map(image => image.imageUrl)).toEqual([oldImage, newImage]);
  });

  test("resume survives a runtime restart while fork, compaction replacement, and mismatch reset", () => {
    const directory = mkdtempSync(join(tmpdir(), "cgw-continuum-resume-"));
    try {
      const path = join(directory, "continuum.json");
      const firstStore = new ChatGptContinuumStore(path, "provider-resume", () => 100);
      const first = parsed("thread-resume", "turn-1", [user("first")]);
      const firstPlan = firstStore.plan(first, first.context.messages);
      firstStore.commit(firstPlan, "answer");

      const resumedMessages = [user("first"), assistant("answer"), user("resumed", 3)];
      const restartedStore = new ChatGptContinuumStore(path, "provider-resume", () => 101);
      expect(restartedStore.plan(
        parsed("thread-resume", "turn-2", resumedMessages),
        resumedMessages,
      ).mode).toBe("delta");

      const fork = restartedStore.plan(parsed("thread-fork", "turn-1", resumedMessages), resumedMessages);
      expect(fork.mode).toBe("full");
      expect(fork.reason).toBe("new_task");

      const compacted = [user("checkpoint summary"), user("after compact", 4)];
      const compactPlan = restartedStore.plan(
        parsed("thread-resume", "turn-3", compacted),
        compacted,
      );
      expect(compactPlan.mode).toBe("full");
      expect(compactPlan.reason).toBe("history_prefix_mismatch");

      const missingOutput = [user("first"), user("new without proven output", 3)];
      const mismatch = restartedStore.plan(
        parsed("thread-resume", "turn-4", missingOutput),
        missingOutput,
      );
      expect(mismatch.mode).toBe("full");
      expect(mismatch.reason).toBe("previous_output_missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("timestamps do not perturb the semantic prefix digest", () => {
    expect(chatGptContinuumContextDigest(["system"], [user("same", 1)]))
      .toBe(chatGptContinuumContextDigest(["system"], [user("same", 9_999)]));
    expect(withoutSupersededModelSwitchContracts([user("same")])).toHaveLength(1);
  });
});
