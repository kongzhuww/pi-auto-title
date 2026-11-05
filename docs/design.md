# Design notes

## Scope

Only automatic first-round session naming and one command, `/auto-title model`.
No subagent, context injection, history backfill, manual generation, overwrite, synchronization, or Pi patches.

## SDK contract

Implemented against the local `@earendil-works/pi-coding-agent@1.5.0` documentation and declarations:

- `docs/extensions.md`, `docs/packages.md`, `docs/session-format.md`, `docs/sdk.md`
- `examples/extensions/session-name.ts`, `examples/extensions/summarize.ts`
- SDK lifecycle examples and `dist/core/extensions/types.d.ts`
- `ModelRegistry.streamSimple`, `StreamOptions.maxRetries/timeoutMs/signal`

`agent_settled` carries `aborted`, not a success status. The extension also checks the persisted final assistant message for `stopReason === "stop"`, no tool call, nonempty visible text, and exactly one user entry. Intermediate errors followed by successful SDK recovery may still produce a title. This is structural success, not an assessment of answer correctness.

The first question comes from `input`, before skill/template expansion. `before_agent_start` arms the first round and persists a content-free consumed marker. Handled input that never starts the agent does not consume a round. A later agent-start hook could still cancel or fail the main request; restoration remains fail-closed.

Title instructions are passed only to the registry's separate model request. No chat `context` hook, `sendMessage`, or `sendUserMessage` is used. The title response is never appended as a conversation message.

## Persistence and race protection

- The marker is stored through `pi.appendEntry` before any title request, even if the first round later fails.
- Existing conversation or marker entries anywhere in the session prevent re-arming on abandoned branches.
- Raw question/answer excerpts are held only in memory, not duplicated in extension metadata.
- Model selection is a separate versioned configuration file under `getAgentDir()`; atomic same-directory replacement avoids partial JSON.
- Result guards check the live instance, shutdown state, AbortSignal, session ID/file, native current name, persisted session-info entry IDs, and presence of the original user entry on the active branch.
- Native name-change notifications cancel work; persisted metadata checks also cover queued/delayed notifications and rename-then-clear.
- No asynchronous gap exists between the final checks and `pi.setSessionName`.
- Timeout races the whole operation, even when a custom provider does not cooperate. Its late result still sees an aborted signal.
- No per-branch regeneration, automatic retries or provider fallback.

This is single-process protection through Pi's authoritative session view. It does not implement multi-process locking or directly access session files.

## Model policy

Default disabled. Explicitly select a provider/model using Pi's configured chat catalog.
Authentication is resolved by the registry, including extension-registered providers.
The dedicated model does not change the main model or implicitly use the main model's scoped-model list.

No reasoning option is supplied to `streamSimple`, which disables optional thinking in supported adapters. Models may enforce a minimum reasoning level. Output budget is 256 tokens; SDK retries are disabled and timeout is 10 seconds. Custom adapters and remote services remain responsible for honoring those controls.

## Prompt and validation

A natural catalog/article title: core object + concrete topic/task. The user's intent wins over an off-topic answer. Chinese targets 8-20 code points, all outputs must fit 30. Required names are preserved.

Reject empty, multiline, oversized, Markdown/JSON, emoji or unsafe control output. Harmless outer quotes and a title prefix are stripped. Do not clip the first question as a fallback. Prompt compliance and semantic quality still depend on the selected model; no regex can prove a title is a good summary.

## Public research

These are verified examples, **not evidence of the private Gemini/ChatGPT/Claude web implementations**:

- Google Gemini CLI: [sessionSummaryService.ts](https://github.com/google-gemini/gemini-cli/blob/1fe22af5f800d8c3024e9968d35bb75bd09e6b79/packages/core/src/services/sessionSummaryService.ts), [sessionSummaryUtils.ts](https://github.com/google-gemini/gemini-cli/blob/1fe22af5f800d8c3024e9968d35bb75bd09e6b79/packages/core/src/services/sessionSummaryUtils.ts). Independent bounded intent summary, timeout and graceful failure. Its previous-session/backfill trigger and file writes are deliberately not copied.
- Open WebUI: [task router](https://github.com/open-webui/open-webui/blob/c38885a1a737da4968f157092f304f3b5481d0bf/backend/open_webui/routers/tasks.py). Separate task model/request and title prompt.
- LibreChat: [title publication](https://github.com/danny-avila/LibreChat/blob/f4154b649efa37e1345ccc517a4d8d1ed2178c82/packages/api/src/conversations/title.ts). Explicit rename authority and discarded stale results.
- Vercel Chatbot: [title generation](https://github.com/vercel/chatbot/blob/a8989b522fa3672a2ae52f053105e40993b36ca1/lib/ai/generate-title.ts). Bounded user-text extraction and a dedicated title request.

Implementation and prompt in this repository are independently written.

## Verification boundaries

Automated tests use synthetic data and an isolated loopback model endpoint. They exercise actual SDK loading, lifecycle and session persistence, but do not prove Gemini OAuth availability, live model quality, billing, custom-provider cancellation, or every Pi distribution's compatibility. Test those separately with an explicitly selected account/model.
