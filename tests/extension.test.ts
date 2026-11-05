import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_TYPE } from "../src/extension.ts";
import { ANSWER_LIMIT, QUESTION_LIMIT, TITLE_INSTRUCTIONS } from "../src/title.ts";
import { MemoryConfig, assistant, configured, deferred, entry, flush, harness, model } from "./harness.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";

test("only one independent request after first settled response; no main-context injection", async () => {
  const h = harness();
  await h.startSession();
  await h.start();
  assert.equal(h.calls.length, 0);
  await h.emit({ type: "agent_end" });
  assert.equal(h.calls.length, 0);
  await h.finish();
  await flush();
  assert.deepEqual(h.writes, ["Pi会话自动命名扩展开发"]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].context.systemPrompt, TITLE_INSTRUCTIONS);
  assert.equal(h.calls[0].context.messages.length, 1);
  assert.equal(h.calls[0].context.tools, undefined);
  assert.equal(h.calls[0].options?.maxRetries, 0);
  assert.ok(h.calls[0].options?.signal);
  assert.ok(h.entries.some((e) => e.type === "custom" && e.customType === STATE_TYPE));
  await h.emit({ type: "agent_settled", aborted: false });
  await h.start("第二个问题");
  await h.finish();
  await flush();
  assert.equal(h.calls.length, 1);
});

test("sends bounded raw question and final visible answer, not skills, thoughts, images or tool output", async () => {
  const h = harness();
  await h.startSession();
  await h.start("问".repeat(5000));
  h.entries.push(entry({ type: "message", message: { role: "system", content: "SYSTEM_SECRET" } }));
  h.entries.push(entry({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "TOOL_SECRET" }] } }));
  const answer = assistant("答".repeat(5000), "stop", [
    { type: "thinking", thinking: "THOUGHT_SECRET" },
    { type: "image", data: "IMAGE_SECRET", mimeType: "image/png" },
    { type: "text", text: "COMMENTARY_SECRET", textSignature: '{"v":1,"phase":"commentary"}' },
  ]);
  await h.finish(answer);
  await flush();
  const serialized = JSON.stringify(h.calls[0].context);
  for (const secret of ["SYSTEM_SECRET", "EXPANDED_SKILL_SECRET", "TOOL_SECRET", "THOUGHT_SECRET", "IMAGE_SECRET", "COMMENTARY_SECRET"]) {
    assert.ok(!serialized.includes(secret), secret);
  }
  const content = h.calls[0].context.messages[0].content as { type: string; text: string }[];
  const input = JSON.parse(content[0].text);
  assert.equal(Array.from(input.question).length, QUESTION_LIMIT);
  assert.equal(Array.from(input.answer).length, ANSWER_LIMIT);
  for (const e of h.entries.filter((e) => e.type === "custom")) {
    assert.ok(!JSON.stringify(e).includes("问"));
  }
});

test("reload and resume never repeat, including an interrupted first round", async () => {
  const h = harness();
  await h.startSession();
  await h.start();
  await h.emit({ type: "session_shutdown", reason: "reload" });
  const reloaded = harness({ entries: h.entries });
  await reloaded.startSession("reload");
  await reloaded.finish();
  await reloaded.start("继续");
  await reloaded.finish();
  await flush();
  assert.equal(reloaded.calls.length, 0);
  const resumed = harness({ entries: h.entries });
  await resumed.startSession("resume");
  await resumed.start();
  await resumed.finish();
  await flush();
  assert.equal(resumed.calls.length, 0);
});

test("old unnamed sessions are never automatically processed", async () => {
  const old = entry({ type: "message", message: { role: "user", content: "old question" } });
  for (const reason of ["startup", "reload", "resume", "fork"]) {
    const h = harness({ entries: [old] });
    await h.startSession(reason);
    await h.start();
    await h.finish();
    await flush();
    assert.equal(h.calls.length, 0, reason);
  }
});

test("reload on a truly empty session still allows its first round", async () => {
  const h = harness();
  await h.startSession("reload");
  await h.start();
  await h.finish();
  await flush();
  assert.equal(h.calls.length, 1);
});

test("existing /name and rename-then-clear are never overwritten", async () => {
  for (const clear of [false, true]) {
    const h = harness();
    h.rename("用户标题");
    if (clear) h.rename(undefined);
    await h.startSession();
    await h.start();
    await h.finish();
    await flush();
    assert.equal(h.calls.length, 0);
  }
});

test("mid-request rename or rename-clear discards even a provider that ignores abort", async () => {
  for (const clear of [false, true]) {
    const response = deferred<AssistantMessage>();
    const h = harness({ result: () => response.promise });
    await h.startSession(); await h.start(); await h.finish(); await flush();
    h.rename("手动标题");
    if (clear) h.rename(undefined);
    response.resolve(assistant());
    await flush();
    assert.equal(h.writes.length, 0);
    assert.equal(h.calls[0].options?.signal?.aborted, true);
  }
});

test("persisted name revision guards even delayed rename notifications", async () => {
  const response = deferred<AssistantMessage>();
  const h = harness({ result: () => response.promise });
  await h.startSession(); await h.start(); await h.finish(); await flush();
  h.rename("temporary", false); h.rename(undefined, false);
  response.resolve(assistant()); await flush();
  assert.equal(h.writes.length, 0);
});

test("switch, shutdown, reload, fork and tree navigation discard stale results", async () => {
  for (const reason of ["new", "resume", "reload", "quit", "fork", "tree"]) {
    const response = deferred<AssistantMessage>();
    const h = harness({ result: () => response.promise });
    await h.startSession(); await h.start(); await h.finish(); await flush();
    if (reason === "tree") await h.emit({ type: "session_tree" });
    else await h.emit({ type: "session_shutdown", reason });
    if (reason !== "quit") {
      h.setKey("session-B");
      await h.startSession(reason === "reload" ? "reload" : "resume");
    }
    response.resolve(assistant()); await flush();
    assert.equal(h.writes.length, 0, reason);
  }
});

test("identity is rechecked even without shutdown notification", async () => {
  const response = deferred<AssistantMessage>();
  const h = harness({ result: () => response.promise });
  await h.startSession(); await h.start(); await h.finish(); await flush();
  h.setKey("session-B"); response.resolve(assistant()); await flush();
  assert.equal(h.writes.length, 0);
});

test("abort, failed/truncated/tool-only/empty/think-only answers never request titles", async () => {
  const cases = [
    { response: assistant("partial"), aborted: true },
    { response: assistant("error", "error") },
    { response: assistant("partial", "length") },
    { response: assistant("partial", "aborted") },
    { response: assistant("", "toolUse", [{ type: "toolCall", id: "call", name: "read", arguments: {} }]) },
    { response: assistant("", "stop", [{ type: "thinking", thinking: "private" }]) },
    { response: assistant(" ") },
  ];
  for (const { response, aborted } of cases) {
    const h = harness();
    await h.startSession(); await h.start(); await h.finish(response, aborted);
    await h.start("后续正常问题"); await h.finish(); await flush();
    assert.equal(h.calls.length, 0, response.stopReason);
  }
});

test("normal recovery after an intermediate error/tool turn generates once at final settlement", async () => {
  const h = harness();
  await h.startSession(); await h.start();
  h.entries.push(entry({ type: "message", message: assistant("error", "error") }));
  await h.emit({ type: "agent_end" });
  h.entries.push(entry({ type: "message", message: assistant("tool", "toolUse") }));
  assert.equal(h.calls.length, 0);
  await h.finish(); await flush();
  assert.equal(h.calls.length, 1);
});

test("title failure cannot reject settled dispatch and is not retried after reload", async () => {
  const h = harness({ result: async () => { throw new Error("PRIVATE_PROVIDER_ERROR"); } });
  await h.startSession(); await h.start();
  await assert.doesNotReject(h.finish()); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
  assert.ok(!JSON.stringify(h.notifications).includes("PRIVATE_PROVIDER_ERROR"));
  await h.startSession("reload"); await h.start(); await h.finish(); await flush();
  assert.equal(h.calls.length, 1);
});

test("settled handler returns while request is pending; timeout aborts and late response cannot write", async () => {
  const response = deferred<AssistantMessage>();
  const h = harness({ result: () => response.promise, timeoutMs: 15 });
  await h.startSession(); await h.start();
  await h.finish(); // Would hang here if the event handler awaited title generation.
  await flush(); assert.equal(h.calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(h.calls[0].options?.signal?.aborted, true);
  response.resolve(assistant()); await flush();
  assert.equal(h.writes.length, 0);
});

test("disabled/missing model or credentials never silently falls back", async () => {
  const config = new MemoryConfig(); config.value.model = null;
  const disabled = harness({ config });
  await disabled.startSession(); await disabled.start(); await disabled.finish(); await flush();
  assert.equal(disabled.calls.length, 0);
  const missing = harness(); missing.setAvailable(false);
  await missing.startSession(); await missing.start(); await missing.finish(); await flush();
  assert.equal(missing.calls.length, 0);
});

test("extension-injected input, image-only input and queued first-round follow-ups are excluded", async () => {
  for (const variant of ["extension", "image", "queued"]) {
    const h = harness(); await h.startSession();
    await h.start(variant === "image" ? " " : "问题", variant === "extension" ? "extension" : "interactive");
    if (variant === "queued") await h.input("第二个问题", "interactive", "followUp");
    await h.finish(); await flush();
    assert.equal(h.calls.length, 0, variant);
  }
});

test("RPC human input is eligible", async () => {
  const h = harness(); await h.startSession(); await h.start("整理PLC试卷", "rpc");
  await h.finish(); await flush(); assert.equal(h.calls.length, 1);
});

test("failure to persist the once-only marker fails closed", async () => {
  const h = harness({ appendFails: true });
  await h.startSession(); await h.start(); await h.finish(); await flush();
  assert.equal(h.calls.length, 0);
});

test("model command saves selection, cancellation leaves it unchanged; no other subcommands", async () => {
  const config = new MemoryConfig(); config.value.model = null;
  const h = harness({ config }); await h.startSession();
  await h.command("generate");
  assert.ok(h.notifications.includes("Usage: /auto-title model"));
  h.setSelection(model.provider + "/" + model.id); await h.command("model");
  assert.deepEqual(config.value, configured);
  h.setSelection(undefined); await h.command("model");
  assert.deepEqual(config.value, configured);
  h.setSelection("Disabled (no title requests)"); await h.command("model");
  assert.equal(config.value.model, null);
  assert.equal(h.calls.length, 0);
});

test("model picker cannot save from a stale session closure", async () => {
  const config = new MemoryConfig(); config.value.model = null;
  const choice = deferred<string | undefined>();
  const h = harness({ config }); await h.startSession();
  h.setPicker(() => choice.promise);
  const command = h.command("model"); await flush();
  await h.emit({ type: "session_shutdown", reason: "resume" });
  h.setKey("session-B"); await h.startSession("resume");
  choice.resolve(model.provider + "/" + model.id); await command;
  assert.equal(config.value.model, null);
});

test("changing title model while generation is pending cancels old request", async () => {
  const response = deferred<AssistantMessage>();
  const h = harness({ result: () => response.promise });
  await h.startSession(); await h.start(); await h.finish(); await flush();
  h.setSelection("Disabled (no title requests)"); await h.command("model");
  response.resolve(assistant()); await flush();
  assert.equal(h.writes.length, 0);
});

test("invalid model output is discarded, not clipped or substituted with the original question", async () => {
  for (const response of [assistant("题".repeat(31)), assistant("First line\nSecond line"), assistant("error", "error"), assistant("", "stop")]) {
    const h = harness({ result: async () => response });
    await h.startSession(); await h.start(); await h.finish(); await flush();
    assert.equal(h.writes.length, 0);
    assert.equal(h.calls.length, 1);
  }
});
