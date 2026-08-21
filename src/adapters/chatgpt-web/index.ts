import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "./browser-worker";
import { selectChatGptContextSpool } from "./context-spool";
import { sharedChatGptContinuumStore, type ChatGptContinuumPlan } from "./continuum";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt, withoutSupersededModelSwitchContracts } from "./prompt";
import { sharedChatGptWebSendRateLimiter } from "./rate-limiter";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(): DOMException {
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

async function waitForBrowserRetryBackoff(
  delayMs: number,
  signal: AbortSignal | undefined,
  emit: (event: AdapterEvent) => void,
): Promise<void> {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    emit({ type: "heartbeat" });
    const remaining = deadline - Date.now();
    await withAbort(
      new Promise<void>(resolveWait => setTimeout(resolveWait, Math.min(1_000, remaining))),
      signal,
    );
  }
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitProContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

export function createChatGptWebAdapter(provider: CodexProviderConfig): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = TurnBroker.forSocket(brokerSocketPath(provider));
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const executionNamespace = createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
  const continuumEnabled = provider.chatgptWeb?.contextMode !== "stateless";
  const browserTurnRetries = provider.chatgptWeb?.browserTurnRetries ?? 0;
  const browserRetryBackoffMs = provider.chatgptWeb?.browserRetryBackoffMs ?? 2_000;
  const browserMinSendIntervalMs = provider.chatgptWeb?.browserMinSendIntervalMs ?? 2_000;
  const browserRateLimitCooldownMs = provider.chatgptWeb?.browserRateLimitCooldownMs ?? 120_000;
  const accountNamespace = createHash("sha256").update(JSON.stringify({
    browserHost: provider.chatgptWeb?.browserHost ?? "managed-chrome",
    accountSurface: provider.chatgptWeb?.browserHostDescriptorPath
      ?? provider.chatgptWeb?.storageStatePath
      ?? provider.baseUrl,
    chromeExecutablePath: provider.chatgptWeb?.chromeExecutablePath ?? "",
  })).digest("hex");
  const browserRateLimitStatePath = provider.chatgptWeb?.browserRateLimitStatePath
    ? resolve(expandUserPath(provider.chatgptWeb.browserRateLimitStatePath))
    : undefined;
  const sendRateLimiter = sharedChatGptWebSendRateLimiter(
    browserRateLimitStatePath,
    accountNamespace,
  );
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const continuumStatePath = provider.chatgptWeb?.continuumStatePath
    ? resolve(expandUserPath(provider.chatgptWeb.continuumStatePath))
    : undefined;
  const continuumStore = sharedChatGptContinuumStore(
    continuumStatePath,
    executionNamespace,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
  ): ChatGptTurnRuntime => {
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const continuumPlan: ChatGptContinuumPlan | undefined = continuumEnabled
      && !parsed._compactionRequest
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      ? continuumStore.plan(
        checkpointInput.parsed,
        withoutSupersededModelSwitchContracts(checkpointInput.parsed.context.messages),
      )
      : undefined;
    if (continuumPlan) {
      console.info(
        `[chatgpt-web] Continuum mode=${continuumPlan.mode} reason=${continuumPlan.reason}`
        + ` deltaMessages=${continuumPlan.messages.length} fullMessages=${continuumPlan.fullMessages.length}`,
      );
    }
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const finalizeContinuum = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (continuumPlan) continuumStore.commit(continuumPlan, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    const runBrowser = (turn: BrowserTurn): Promise<string> => (async () => {
      await sendRateLimiter.beforeSend(
        browserMinSendIntervalMs,
        browserRateLimitCooldownMs,
        browserAbort.signal,
        delayMs => console.info(
          `[chatgpt-web] account send gate spacing a new browser turn by ${delayMs}ms`,
        ),
      );
      try {
        return await worker.run(turn);
      } catch (error) {
        if (error instanceof ChatGptWebAdapterError
          && error.status === 429
          && error.code === "rate_limit_exceeded") {
          const cooldownUntil = sendRateLimiter.recordRateLimit(browserRateLimitCooldownMs);
          console.warn(
            `[chatgpt-web] ChatGPT rate limit activated the account send cooldown until ${new Date(cooldownUntil).toISOString()}`,
          );
        }
        throw error;
      }
    })();
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    if (!mode.localTools) {
      const browser = finalizeCheckpoint(finalizeContinuum(runBrowser({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            { captureLunaCheckpoint, ...(continuumPlan ? { continuumPlan } : {}) },
          ),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })));
      return {
        mode: "read-only",
        browser,
        trace,
        text,
        cancel: () => browserAbort.abort(),
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const finalizeContextSpool = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!activeToken) throw new Error("ChatGPT context spool lost its active turn token");
      broker.assertContextSpoolComplete(activeToken);
      return answer;
    });
    const browser = finalizeCheckpoint(finalizeContinuum(finalizeContextSpool(runBrowser({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      prepare: async () => {
        const turnToken = await broker.register(
          environment,
          timeoutMs === undefined ? undefined : timeoutMs + 60_000,
          traceId,
        );
        activeToken = turnToken;
        tokenSettled = true;
        token.resolve(turnToken);
        try {
          const compiled = compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            turnToken,
            { captureLunaCheckpoint, ...(continuumPlan ? { continuumPlan } : {}) },
          );
          const selection = selectChatGptContextSpool(
            compiled,
            turnToken,
            mode.modelId,
            mode.effort,
            turnCapabilities,
          );
          if (selection.spool) {
            broker.attachContextSpool(turnToken, selection.spool);
            console.info(
              `[chatgpt-web] context spool selected chunks=${selection.spool.chunks.length}`
              + ` aggregateEstimatedInputTokens=${selection.aggregateInputTokens ?? "unknown"}`,
            );
          } else if (selection.reason !== "not_needed"
            && selection.reason !== "delta_requires_browser_verification") {
            console.info(`[chatgpt-web] context spool not selected reason=${selection.reason}`);
          }
          return { ...selection.prepared, release: () => {} };
        } catch (error) {
          broker.revoke(turnToken);
          throw error;
        }
      },
      abortSignal: browserAbort.signal,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => text.push(delta),
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    }))));
    void browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      browser,
      trace,
      text,
      cancel: () => {
        browserAbort.abort();
        if (activeToken) broker.revoke(activeToken);
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      if (parsed._opaqueMultiAgentV2Payload) {
        throw new Error(
          "ChatGPT Web subagents currently require a V1-rooted task. "
          + "Refresh the Codex model catalog and start a new task; an existing V2 task cannot migrate surfaces. "
          + "Codex MultiAgent V2 encrypts cross-backend task payloads.",
        );
      }
      const turnCapabilities = parsed._compactionRequest
        ? { ...configuredCapabilities, localToolsEnabled: false }
        : configuredCapabilities;
      const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
      const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
      const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey, browserTurnRetries);
      if (exhaustedRetry) {
        emit({
          type: "error",
          message: exhaustedRetry.message,
          status: exhaustedRetry.status,
          errorType: exhaustedRetry.errorType,
          code: exhaustedRetry.code,
          retryable: false,
        });
        return;
      }
      const retryDelayMs = chatGptWebTurnRetryPolicy.retryDelayMs(retryKey, browserTurnRetries);
      if (retryDelayMs > 0) {
        console.info(`[chatgpt-web] waiting ${retryDelayMs}ms before an explicitly configured browser retry`);
        await waitForBrowserRetryBackoff(retryDelayMs, incoming.abortSignal, emit);
      }
      let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
      if (mode.localTools) {
        try {
          environment = environmentStore.resolve(parsed);
        } catch (error) {
          const identity = extractChatGptTurnIdentity(parsed);
          console.warn(
            `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
          );
          throw error;
        }
      }
      if (parsed._compactionRequest) {
        const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
        await chatGptTurnSessions.retireAndWait(responseExecutionKey);
      }
      const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      await chatGptTurnSessions.waitForRetirement(executionKey);
      const traceId = createHash("sha256").update(executionKey).digest("hex").slice(0, 12);
      const session = chatGptTurnSessions.getOrCreate(
        executionKey,
        () => startRuntime(parsed, environment, traceId, turnCapabilities),
      );
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      try {
        emit({ type: "heartbeat" });
        await session.runExclusive(async () => {
          const settled = session.settledOutcome();
          if (settled) {
            if (settled.type === "error") throw settled.error;
            let reasoning = session.reasoningForFinalReplay();
            const replay = session.eventsForFinalReplay();
            if (replay.length > 0) {
              replayEvents(replay, emit);
            } else {
              const events: AdapterEvent[] = [];
              const emitCaptured = (event: AdapterEvent) => {
                events.push(event);
                emit(event);
              };
              if (!parsed._compactionRequest) emitProContextWarning(parsed, turnCapabilities, emitCaptured);
              const trace = session.runtime.trace.drain();
              reasoning = trace.map(event => event.text);
              emitTraceEvents(trace, emitCaptured);
              emitTextDeltas(session.runtime.text.drain(), emitCaptured);
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(events);
            }
            emitBrowserCompletion(settled, estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities), emit);
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }

          let turnToken: string | undefined;
          if (session.runtime.mode === "tools") {
            turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
            if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
            broker.updateEnvironment(turnToken, environment);

            const outstanding = session.outstanding();
            if (outstanding.length > 0) {
              const results = currentToolResults(parsed, session);
              if (results.length === 0) {
                const reasoning = session.reasoningForOutstandingReplay();
                replayEvents(session.eventsForOutstandingReplay(), emit);
                emitToolBatch(outstanding, estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities), emit);
                return;
              }
              if (results.length !== outstanding.length) {
                throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
              }
              for (const message of results) {
                broker.completeTool(turnToken, message.toolCallId, brokerResult(message));
                session.markResultDelivered(message.toolCallId);
              }
            }
          } else if (session.outstanding().length > 0) {
            throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
          }

          const toolWaitAbort = new AbortController();
          try {
            const roundReasoning: string[] = [];
            const roundEvents: AdapterEvent[] = [];
            const emitRound = (event: AdapterEvent) => {
              roundEvents.push(event);
              emit(event);
            };
            const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
              roundReasoning.push(...trace.map(event => event.text));
              emitTraceEvents(trace, emitRound);
            };
            const emitNewText = (deltas: string[]) => emitTextDeltas(deltas, emitRound);
            if (!parsed._compactionRequest) emitProContextWarning(parsed, turnCapabilities, emitRound);
            emitNewTrace(session.runtime.trace.drain());
            emitNewText(session.runtime.text.drain());
            const nextTools = turnToken
              ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(requests => ({ type: "tools" as const, requests }))
              : undefined;
            const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
            let nextTrace = session.runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
            let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
            for (;;) {
              const next = await withAbort(
                Promise.race([
                  ...(nextTools ? [nextTools] : []),
                  browserOutcome,
                  nextTrace,
                  nextText,
                ]),
                incoming.abortSignal,
              );
              if (next.type === "trace") {
                emitNewTrace(session.runtime.trace.drain());
                nextTrace = session.runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
                continue;
              }
              if (next.type === "text") {
                emitNewText(session.runtime.text.drain());
                nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
                continue;
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              if (next.type === "browser") {
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(roundEvents);
                if (turnToken) broker.revoke(turnToken);
                if (next.outcome.type === "error") throw next.outcome.error;
                if (session.runtime.text.value() !== next.outcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                emitBrowserCompletion(
                  next.outcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: next.outcome.answer, reasoning: roundReasoning }, turnCapabilities),
                  emit,
                );
                chatGptWebTurnRetryPolicy.clear(retryKey);
                return;
              }
              if (!turnToken || session.runtime.mode !== "tools") {
                throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
              }
              if (next.requests.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
              validateBatchTools(parsed, next.requests);
              session.setOutstanding(next.requests, roundReasoning, roundEvents);
              emitToolBatch(
                next.requests,
                estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities),
                emit,
              );
              return;
            }
          } finally {
            toolWaitAbort.abort();
          }
        });
      } catch (error) {
        const handledError = error instanceof ChatGptWebAdapterError && error.retryable
          ? chatGptWebTurnRetryPolicy.recordRetryableFailure(
            retryKey,
            error,
            browserTurnRetries,
            browserRetryBackoffMs,
          )
          : error;
        if (!(error instanceof ChatGptWebAdapterError && error.retryable)) {
          chatGptWebTurnRetryPolicy.clear(retryKey);
        }
        if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
          // A deterministic request failure remains replayable so a native reconnect cannot burn
          // another browser attempt. Every other failure retires the browser session: client
          // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
          // instead of replaying one rejected browser outcome for the registry's full TTL.
          session.cancel();
        } else {
          chatGptTurnSessions.retire(executionKey, session);
        }
        if (session.runtime.mode === "tools") {
          void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
        }
        if (handledError instanceof ChatGptWebAdapterError) {
          emit({
            type: "error",
            message: handledError.message,
            status: handledError.status,
            errorType: handledError.errorType,
            code: handledError.code,
            retryable: handledError.retryable,
          });
          return;
        }
        chatGptWebTurnRetryPolicy.clear(retryKey);
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
