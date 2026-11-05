import type { AssistantMessage, Context, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ConfigStore, TitleConfig } from "../src/config.ts";
import { registerAutoTitle } from "../src/extension.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
export const model = { provider: "test-provider", id: "title-model" };
export const configured: TitleConfig = { version: 1, model: { provider: model.provider, modelId: model.id } };

export class MemoryConfig implements ConfigStore {
  value: TitleConfig = structuredClone(configured);
  async load(): Promise<TitleConfig> { return structuredClone(this.value); }
  async save(value: TitleConfig): Promise<void> { this.value = structuredClone(value); }
}

let nextId = 0;
export function entry(value: Record<string, unknown>): SessionEntry {
  return { id: String(++nextId), parentId: null, timestamp: new Date().toISOString(), ...value } as SessionEntry;
}

export function assistant(text = "Pi会话自动命名扩展开发", stopReason = "stop", extra: unknown[] = []): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }, ...extra], stopReason,
    api: "test", provider: model.provider, model: model.id, timestamp: Date.now(),
  } as AssistantMessage;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export function harness(options: {
  entries?: SessionEntry[]; config?: ConfigStore; timeoutMs?: number;
  result?: () => Promise<AssistantMessage>; appendFails?: boolean;
} = {}) {
  const handlers = new Map<string, Handler[]>();
  const entries = options.entries?.slice() ?? [];
  const notifications: string[] = [];
  const writes: string[] = [];
  const calls: { context: Context; options?: ModelsSimpleStreamOptions }[] = [];
  let command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
  let key = "session-A";
  let name: string | undefined;
  let available = true;
  let idle = true;
  let selection: string | undefined;
  let picker: (() => Promise<string | undefined>) | undefined;
  const config = options.config ?? new MemoryConfig();
  const sessionManager = {
    getSessionId: () => key,
    getSessionFile: () => "/synthetic/" + key + ".jsonl",
    getHeader: () => ({ id: key }),
    getEntries: () => entries.slice(),
    getBranch: () => entries.slice(),
  };
  const ctx = {
    hasUI: true, mode: "tui", sessionManager, isIdle: () => idle,
    modelRegistry: {
      find: (provider: string, id: string) => available && provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => available,
      getAvailable: () => available ? [model] : [],
      streamSimple: (_model: unknown, context: Context, opts?: ModelsSimpleStreamOptions) => {
        calls.push({ context, options: opts });
        return { result: options.result ?? (async () => assistant()) };
      },
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async () => picker ? picker() : selection,
    },
  } as unknown as ExtensionCommandContext;

  const emit = async (event: { type: string; [key: string]: unknown }) => {
    for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
  };
  const rename = (value?: string, notify = true) => {
    name = value;
    entries.push(entry({ type: "session_info", name }));
    if (notify) void emit({ type: "session_info_changed", name });
  };
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand: (name: string, definition: typeof command) => {
      if (name !== "auto-title") throw new Error("Unexpected command");
      command = definition;
    },
    getSessionName: () => name,
    setSessionName: (title: string) => { writes.push(title); rename(title); },
    appendEntry: (customType: string, data: unknown) => {
      if (options.appendFails) throw new Error("Synthetic persistence failure");
      entries.push(entry({ type: "custom", customType, data }));
    },
    // No sendMessage/sendUserMessage implementation: accidental context pollution fails tests.
  } as unknown as ExtensionAPI;
  registerAutoTitle(pi, config, { timeoutMs: options.timeoutMs ?? 500 });

  return {
    entries, writes, calls, notifications, config, ctx, rename, emit,
    setKey: (value: string) => { key = value; },
    setAvailable: (value: boolean) => { available = value; },
    setIdle: (value: boolean) => { idle = value; },
    setSelection: (value?: string) => { selection = value; },
    setPicker: (value: () => Promise<string | undefined>) => { picker = value; },
    command: (args: string) => command.handler(args, ctx),
    startSession: (reason = "startup") => emit({ type: "session_start", reason }),
    input: (text: string, source = "interactive", streamingBehavior?: string) => emit({ type: "input", text, source, streamingBehavior }),
    async start(text = "开发一个Pi自动会话标题扩展", source = "interactive") {
      await emit({ type: "input", text, source });
      await emit({ type: "before_agent_start", messageType: "user", prompt: "EXPANDED_SKILL_SECRET" });
      entries.push(entry({ type: "message", message: { role: "user", content: "EXPANDED_SKILL_SECRET", timestamp: Date.now() } }));
    },
    async finish(message: AssistantMessage = assistant("已经实现扩展，并提供测试。"), aborted = false) {
      entries.push(entry({ type: "message", message }));
      await emit({ type: "agent_settled", aborted });
    },
  };
}
