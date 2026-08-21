import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import type {
  CodexAssistantMessage,
  CodexMessage,
  CodexParsedRequest,
} from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

const CONTINUUM_STATE_VERSION = 1;
const CONTINUUM_STATE_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_CONTINUUM_TASKS = 256;
const RETIRED_TURN_HANDLE = /\b(turn|binding)_[A-Za-z0-9_-]{24,}/g;
const sharedStores = new Map<string, ChatGptContinuumStore>();

export type ChatGptContinuumResetReason =
  | "new_task"
  | "state_recovered"
  | "system_changed"
  | "history_prefix_mismatch"
  | "previous_output_missing";

export interface ChatGptContinuumPlan {
  taskKey: string;
  mode: "full" | "delta";
  reason: ChatGptContinuumResetReason | "acknowledged_prefix";
  system: string[];
  messages: CodexMessage[];
  fullSystem: string[];
  fullMessages: CodexMessage[];
  contextDigest: string;
  marker: string;
  expectedPreviousMarker?: string;
  previousContextDigest?: string;
  messageDigests: string[];
}

interface StoredContinuumTask {
  systemDigest: string;
  inputMessageDigests: string[];
  completedAnswerDigest: string;
  contextDigest: string;
  marker: string;
  updatedAt: number;
}

interface StoredContinuumFile {
  version: typeof CONTINUUM_STATE_VERSION;
  tasks: Record<string, StoredContinuumTask>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function semanticMessage(message: CodexMessage): unknown {
  if (message.role === "toolResult") {
    return {
      role: message.role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      toolNamespace: message.toolNamespace,
      content: message.content,
      isError: message.isError,
    };
  }
  if (message.role === "assistant") {
    return {
      role: message.role,
      content: message.content,
      phase: message.phase,
      model: message.model,
    };
  }
  return { role: message.role, content: message.content };
}

function transportCanonicalJson(value: unknown): string {
  return canonicalJson(value).replace(RETIRED_TURN_HANDLE, (_handle, kind: string) => `[retired ${kind} handle]`);
}

export function chatGptContinuumMessageDigest(message: CodexMessage): string {
  return sha256(transportCanonicalJson(semanticMessage(message)));
}

export function chatGptContinuumContextDigest(system: readonly string[], messages: readonly CodexMessage[]): string {
  return sha256(transportCanonicalJson({
    system: [...system],
    messages: messages.map(semanticMessage),
  }));
}

export function chatGptContinuumMarker(taskKey: string, contextDigest: string): string {
  return `<codex_continuum_state version="1" task="${taskKey}" context_digest="${contextDigest}" />`;
}

function assistantVisibleText(message: CodexAssistantMessage): string {
  return message.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("");
}

function acknowledgedOutputEnd(
  messages: readonly CodexMessage[],
  start: number,
  completedAnswerDigest: string,
): number | undefined {
  let accumulated = "";
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.phase === "commentary") continue;
    accumulated += assistantVisibleText(message);
    if (sha256(accumulated) === completedAnswerDigest) return index + 1;
  }
  return undefined;
}

function validateDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid persisted ChatGPT Continuum ${label}`);
  }
  return value;
}

function validateStoredTask(value: unknown): StoredContinuumTask {
  const parsed = record(value);
  if (!parsed || !Number.isFinite(parsed.updatedAt)) {
    throw new Error("Invalid persisted ChatGPT Continuum task");
  }
  if (!Array.isArray(parsed.inputMessageDigests)) {
    throw new Error("Invalid persisted ChatGPT Continuum message digests");
  }
  const inputMessageDigests = parsed.inputMessageDigests.map((digest, index) => (
    validateDigest(digest, `message digest ${index}`)
  ));
  const marker = parsed.marker;
  if (typeof marker !== "string" || marker.length > 512 || !marker.startsWith("<codex_continuum_state ")) {
    throw new Error("Invalid persisted ChatGPT Continuum marker");
  }
  return {
    systemDigest: validateDigest(parsed.systemDigest, "system digest"),
    inputMessageDigests,
    completedAnswerDigest: validateDigest(parsed.completedAnswerDigest, "answer digest"),
    contextDigest: validateDigest(parsed.contextDigest, "context digest"),
    marker,
    updatedAt: parsed.updatedAt as number,
  };
}

/**
 * Fail-closed, digest-only state for binding one Codex task to one ChatGPT transcript.
 * Conversation text remains in Codex/ChatGPT; this file stores only semantic hashes and the
 * marker needed to prove that a retained browser surface is the expected one.
 */
export class ChatGptContinuumStore {
  private loaded = false;
  private recoveredCorruptState = false;
  private readonly tasks = new Map<string, StoredContinuumTask>();

  constructor(
    private readonly path?: string,
    private readonly namespace = "chatgpt-web",
    private readonly now: () => number = Date.now,
  ) {}

  plan(parsed: CodexParsedRequest, messages: CodexMessage[]): ChatGptContinuumPlan {
    if (parsed._compactionRequest) throw new Error("ChatGPT Continuum does not bind compaction helper turns");
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId) {
      throw new Error("ChatGPT Continuum requires native Codex thread_id and turn_id metadata");
    }
    this.load();
    const recoveredCorruptState = this.recoveredCorruptState;
    this.recoveredCorruptState = false;
    this.prune();
    const taskKey = sha256(`${this.namespace}\0${identity.threadId}`);
    const fullSystem = [...(parsed.context.systemPrompt ?? [])];
    const fullMessages = [...messages];
    const systemDigest = sha256(transportCanonicalJson(fullSystem));
    const messageDigests = fullMessages.map(chatGptContinuumMessageDigest);
    const contextDigest = chatGptContinuumContextDigest(fullSystem, fullMessages);
    const marker = chatGptContinuumMarker(taskKey, contextDigest);
    const previous = this.tasks.get(taskKey);

    const full = (reason: ChatGptContinuumResetReason): ChatGptContinuumPlan => ({
      taskKey,
      mode: "full",
      reason,
      system: fullSystem,
      messages: fullMessages,
      fullSystem,
      fullMessages,
      contextDigest,
      marker,
      messageDigests,
    });

    if (recoveredCorruptState) return full("state_recovered");
    if (!previous) return full("new_task");
    if (previous.systemDigest !== systemDigest) return full("system_changed");
    if (previous.inputMessageDigests.length > messageDigests.length
      || previous.inputMessageDigests.some((digest, index) => messageDigests[index] !== digest)) {
      return full("history_prefix_mismatch");
    }
    const acknowledgedEnd = acknowledgedOutputEnd(
      fullMessages,
      previous.inputMessageDigests.length,
      previous.completedAnswerDigest,
    );
    if (acknowledgedEnd === undefined) return full("previous_output_missing");
    return {
      taskKey,
      mode: "delta",
      reason: "acknowledged_prefix",
      system: [],
      messages: fullMessages.slice(acknowledgedEnd),
      fullSystem,
      fullMessages,
      contextDigest,
      marker,
      expectedPreviousMarker: previous.marker,
      previousContextDigest: previous.contextDigest,
      messageDigests,
    };
  }

  commit(plan: ChatGptContinuumPlan, answer: string): void {
    if (!answer) throw new Error("ChatGPT Continuum refuses to acknowledge an empty browser answer");
    this.load();
    this.tasks.delete(plan.taskKey);
    this.tasks.set(plan.taskKey, {
      systemDigest: sha256(transportCanonicalJson(plan.fullSystem)),
      inputMessageDigests: [...plan.messageDigests],
      completedAnswerDigest: sha256(answer),
      contextDigest: plan.contextDigest,
      marker: plan.marker,
      updatedAt: this.now(),
    });
    this.prune();
    this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredContinuumFile>;
      const tasks = record(parsed.tasks);
      if (parsed.version !== CONTINUUM_STATE_VERSION || !tasks) {
        throw new Error("Invalid ChatGPT Continuum state store");
      }
      const cutoff = this.now() - CONTINUUM_STATE_TTL_MS;
      const entries = Object.entries(tasks)
        .map(([taskKey, value]) => {
          if (!/^[a-f0-9]{64}$/.test(taskKey)) throw new Error("Invalid persisted ChatGPT Continuum task key");
          const task = validateStoredTask(value);
          if (task.marker !== chatGptContinuumMarker(taskKey, task.contextDigest)) {
            throw new Error("Invalid persisted ChatGPT Continuum task marker binding");
          }
          return [taskKey, task] as const;
        })
        .filter(([, task]) => task.updatedAt >= cutoff)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(-MAX_CONTINUUM_TASKS);
      for (const [taskKey, task] of entries) this.tasks.set(taskKey, task);
    } catch {
      this.tasks.clear();
      this.recoveredCorruptState = true;
      try {
        renameSync(
          this.path,
          `${this.path}.corrupt-${this.now()}-${process.pid}-${randomBytes(4).toString("hex")}`,
        );
      } catch {
        // Preserve inaccessible evidence. The invalid contents remain rejected and this process
        // still starts from an empty ledger, so no delta can be authorized from corrupt state.
      }
      console.warn("[chatgpt-web] invalid Continuum state was rejected; forcing a full-context reset");
    }
  }

  private prune(): void {
    const cutoff = this.now() - CONTINUUM_STATE_TTL_MS;
    for (const [taskKey, task] of this.tasks) {
      if (task.updatedAt < cutoff) this.tasks.delete(taskKey);
    }
    while (this.tasks.size > MAX_CONTINUUM_TASKS) {
      const oldest = this.tasks.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tasks.delete(oldest);
    }
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredContinuumFile = {
      version: CONTINUUM_STATE_VERSION,
      tasks: Object.fromEntries(this.tasks),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

export function sharedChatGptContinuumStore(
  path: string | undefined,
  namespace: string,
): ChatGptContinuumStore {
  if (!path) return new ChatGptContinuumStore(undefined, namespace);
  const key = `${path}\0${namespace}`;
  let store = sharedStores.get(key);
  if (!store) {
    store = new ChatGptContinuumStore(path, namespace);
    sharedStores.set(key, store);
  }
  return store;
}
