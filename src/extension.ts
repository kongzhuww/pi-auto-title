import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "./config.ts";
import { ANSWER_LIMIT, QUESTION_LIMIT, TITLE_INSTRUCTIONS, boundedText, cleanTitle, titleInput, visibleText } from "./title.ts";

export const STATE_TYPE = "pi-auto-title:v1";
export const TIMEOUT_MS = 10_000;

interface SessionState {
  key: string;
  active: boolean;
  eligible: boolean;
  started: boolean;
  settled: boolean;
  extraInput: boolean;
  candidate?: string;
  question?: string;
  abort?: AbortController;
}

function sessionKey(ctx: ExtensionContext): string {
  return JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile() ?? null]);
}

function nameRevision(entries: readonly SessionEntry[]): string {
  // Check persisted metadata too: its notification can still be waiting in the event queue.
  return entries.filter((entry) => entry.type === "session_info").map((entry) => entry.id).join("|");
}

function isUnused(entries: readonly SessionEntry[]): boolean {
  // Deliberately session-wide, not branch-wide: /tree must not re-arm automatic naming.
  return !entries.some((entry) =>
    (entry.type === "message" && entry.message.role !== "system") ||
    entry.type === "custom_message" || entry.type === "compaction" ||
    entry.type === "branch_summary" || entry.type === "session_info" ||
    (entry.type === "custom" && entry.customType === STATE_TYPE));
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

/** Exported separately from the entry point so tests need no running Pi or credentials. */
export function registerAutoTitle(pi: ExtensionAPI, config: ConfigStore, options: { timeoutMs?: number } = {}): void {
  let current: SessionState | undefined;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  const cancel = (state: SessionState | undefined): void => {
    if (!state) return;
    state.eligible = false;
    state.candidate = undefined;
    state.question = undefined;
    state.abort?.abort();
  };

  pi.on("session_start", (event, ctx) => {
    cancel(current);
    current = {
      key: sessionKey(ctx), active: true,
      eligible: event.reason !== "resume" && event.reason !== "fork" &&
        !ctx.sessionManager.getHeader()?.parentSession &&
        !pi.getSessionName() && isUnused(ctx.sessionManager.getEntries()),
      started: false, settled: false, extraInput: false,
    };
  });

  pi.on("session_shutdown", () => {
    if (current) current.active = false;
    cancel(current);
    current = undefined;
  });
  pi.on("session_info_changed", () => cancel(current));
  pi.on("session_tree", () => cancel(current));

  pi.on("input", (event, ctx) => {
    const state = current;
    if (!state?.active || state.key !== sessionKey(ctx)) return;
    if (state.started && !state.settled) {
      // A steering/follow-up turn has no distinct settled boundary. Skip rather than
      // accidentally pairing the first question with the second question's answer.
      state.extraInput = true;
      return;
    }
    if (!state.eligible || state.started) return;
    state.candidate = undefined;
    if (event.source === "extension" || event.streamingBehavior || !ctx.isIdle()) return;
    if (!isUnused(ctx.sessionManager.getEntries())) {
      state.eligible = false;
      return;
    }
    state.candidate = boundedText(event.text, QUESTION_LIMIT) || undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    const state = current;
    if (!state?.active || !state.eligible || state.started) return;
    if (event.messageType !== "user" || !state.candidate || pi.getSessionName()) {
      cancel(state);
      return;
    }
    state.started = true;
    state.question = state.candidate;
    state.candidate = undefined;
    try {
      // A durable consumed marker, never a model-facing message. No question or answer is stored here.
      pi.appendEntry(STATE_TYPE, { version: 1, phase: "first-round-started" });
    } catch {
      cancel(state); // Failure to persist the once-only guard must fail closed.
    }
  });

  async function generate(state: SessionState, ctx: ExtensionContext, question: string, answer: string, userEntryId: string): Promise<void> {
    const controller = new AbortController();
    state.abort = controller;
    const revision = nameRevision(ctx.sessionManager.getEntries());
    const valid = (): boolean => current === state && state.active && !controller.signal.aborted &&
      state.key === sessionKey(ctx) && !pi.getSessionName() &&
      revision === nameRevision(ctx.sessionManager.getEntries()) &&
      ctx.sessionManager.getBranch().some((entry) => entry.id === userEntryId);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Auto-title cancelled"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const work = async (): Promise<void> => {
        const selection = (await config.load()).model;
        if (!selection || !valid()) return;
        const model = ctx.modelRegistry.find(selection.provider, selection.modelId);
        if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
          if (valid()) notify(ctx, "Auto-title: selected model is unavailable. Use /auto-title model.", "warning");
          return;
        }
        pi.appendEntry(STATE_TYPE, { version: 1, phase: "requested", provider: model.provider, modelId: model.id });
        if (!valid()) return;
        // The registry resolves Pi's providers and authentication. No main-agent prompt,
        // tools, history, skills, or messages are reused or appended.
        const response = await ctx.modelRegistry.streamSimple(model, {
          systemPrompt: TITLE_INSTRUCTIONS,
          messages: [{ role: "user", content: [{ type: "text", text: titleInput(question, answer) }], timestamp: Date.now() }],
        }, {
          // Omitting reasoning disables optional thinking in streamSimple adapters.
          maxTokens: 256, maxRetries: 0, timeoutMs,
          signal: controller.signal, cacheRetention: "none",
        }).result();
        if (!valid() || response.stopReason !== "stop") return;
        const title = cleanTitle(visibleText(response.content, 256));
        if (!title || !valid()) return;
        // There is deliberately no await between the final guard and this native write.
        pi.setSessionName(title);
      };
      // Race even if a custom provider ignores AbortSignal. Its eventual result cannot write.
      await Promise.race([work(), aborted]);
    } catch {
      // Never log provider errors: they can contain credentials, request bodies, or private text.
      if (current === state && state.active && !controller.signal.aborted) {
        notify(ctx, "Auto-title: generation failed; chat is unaffected.", "warning");
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      if (state.abort === controller) state.abort = undefined;
    }
  }

  pi.on("agent_settled", (event, ctx) => {
    const state = current;
    if (!state?.active || !state.eligible || !state.started || state.settled) return;
    state.settled = true; // Consume even an aborted, failed, empty, or unconfigured first round.
    const question = state.question;
    state.question = undefined;
    if (event.aborted || state.extraInput || !question || pi.getSessionName() || state.key !== sessionKey(ctx)) return;
    const branch = ctx.sessionManager.getBranch();
    const users = branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
    if (users.length !== 1) return;
    const lastAssistant = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (lastAssistant?.type !== "message" || lastAssistant.message.role !== "assistant") return;
    if (lastAssistant.message.stopReason !== "stop" ||
        lastAssistant.message.content.some((block) => block.type === "toolCall")) return;
    const answer = visibleText(lastAssistant.message.content, ANSWER_LIMIT);
    if (!answer) return;
    // Return immediately: awaiting here would delay settled dispatch and the next main-agent run.
    void generate(state, ctx, question, answer, users[0].id);
  });

  pi.registerCommand("auto-title", {
    description: "Choose the dedicated title model: /auto-title model",
    getArgumentCompletions: (prefix) => "model".startsWith(prefix)
      ? [{ value: "model", label: "model", description: "Choose the dedicated title model" }] : null,
    handler: async (args, ctx) => {
      if (args.trim() !== "model") {
        notify(ctx, "Usage: /auto-title model");
        return;
      }
      if (!ctx.hasUI) return;
      const state = current;
      try {
        const saved = await config.load();
        if (current !== state || !state?.active) return;
        const models = ctx.modelRegistry.getAvailable().slice().sort((a, b) =>
          (a.provider + "/" + a.id).localeCompare(b.provider + "/" + b.id));
        const disabled = "Disabled (no title requests)";
        const labels = models.map((model) => model.provider + "/" + model.id);
        const selected = saved.model ? saved.model.provider + "/" + saved.model.modelId : "disabled";
        // Use Pi's native inline selector, not a custom overlay/backdrop.
        const choice = await ctx.ui.select(
          `Title model: ${selected}. Each title sends bounded first-turn text and uses extra quota.`,
          [disabled, ...labels],
        );
        if (!choice || current !== state || !state.active) return;
        const model = models[labels.indexOf(choice)];
        if (choice !== disabled && !model) return;
        await config.save({ version: 1, model: model ? { provider: model.provider, modelId: model.id } : null });
        if (current !== state || !state.active) return;
        state.abort?.abort();
        notify(ctx, model ? `Title model saved: ${model.provider}/${model.id}. Main model unchanged.` : "Automatic titles disabled.");
      } catch {
        if (current === state && state?.active) notify(ctx, "Auto-title: could not read or save model configuration.", "warning");
      }
    },
  });
}
