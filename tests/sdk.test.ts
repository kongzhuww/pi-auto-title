import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { AgentSession, SessionManager as SessionManagerType } from "@earendil-works/pi-coding-agent";
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  (process.env.PI_AUTO_TITLE_TEST_SDK
    ? await import(pathToFileURL(process.env.PI_AUTO_TITLE_TEST_SDK).href)
    : await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
import { FileConfigStore } from "../src/config.ts";
import { STATE_TYPE } from "../src/extension.ts";
import { TITLE_INSTRUCTIONS } from "../src/title.ts";

// Real SDK + real extension loader + real native session persistence. The only
// HTTP service is this synthetic loopback server: no external model or credentials.
test("real SDK loads entry point, persists native title, isolates requests, and does not regenerate on resume", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-title-sdk-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const requests: { model: string; messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const text = payload.model === "title" ? "Pi会话自动命名扩展开发" : "已说明扩展开发方案。";
    if (payload.model === "title") await delay(30);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "synthetic-response", object: "chat.completion.chunk", created: 1, model: payload.model };
    response.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }) + "\n\n");
    response.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
    response.end("data: [DONE]\n\n");
  });
  const sessions: AgentSession[] = [];
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "catalog.json"), allowModelNetwork: false,
    });
    runtime.registerProvider("synthetic-title-test", {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "synthetic-not-a-real-credential",
      models: ["main", "title"].map((id) => ({
        id, name: id, reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000, maxTokens: 1024,
      })),
    });
    const model = runtime.getModel("synthetic-title-test", "main");
    assert.ok(model);
    await new FileConfigStore(join(root, "auto-title.json")).save({
      version: 1, model: { provider: "synthetic-title-test", modelId: "title" },
    });
    const errors: string[] = [];
    const create = async (manager: SessionManagerType, resumed = false) => {
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
      });
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [resolve("src/index.ts")], systemPrompt: "SYNTHETIC_MAIN_SYSTEM_SECRET",
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const result = await createAgentSession({
        cwd: root, agentDir: root, modelRuntime: runtime, model, thinkingLevel: "off", tools: [],
        resourceLoader: loader, settingsManager, sessionManager: manager,
        sessionStartEvent: { type: "session_start", reason: resumed ? "resume" : "startup" },
      });
      sessions.push(result.session);
      await result.session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
      return result.session;
    };
    const manager = SessionManager.create(root, join(root, "sessions"));
    const session = await create(manager);
    await session.prompt("开发一个Pi自动会话标题扩展", { source: "interactive" });
    for (let i = 0; !manager.getSessionName() && i < 100; i++) await delay(10);
    assert.equal(manager.getSessionName(), "Pi会话自动命名扩展开发");
    assert.equal(session.model?.id, "main");
    assert.equal(requests.filter((request) => request.model === "title").length, 1);
    const titleRequest = requests.find((request) => request.model === "title")!;
    assert.ok(JSON.stringify(titleRequest).includes("开发一个Pi自动会话标题扩展"));
    assert.ok(!JSON.stringify(titleRequest).includes("SYNTHETIC_MAIN_SYSTEM_SECRET"));
    assert.ok(manager.getEntries().some((entry) => entry.type === "session_info"));
    assert.ok(manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === STATE_TYPE));
    assert.ok(!JSON.stringify(manager.buildSessionContext()).includes(TITLE_INSTRUCTIONS));
    await session.prompt("第二轮问题");
    assert.ok(!JSON.stringify(requests.filter((request) => request.model === "main")).includes("Create one concise, searchable conversation title"));
    assert.equal(requests.filter((request) => request.model === "title").length, 1);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    session.dispose();
    const restoredManager = SessionManager.open(sessionFile, join(root, "sessions"));
    assert.equal(restoredManager.getSessionName(), "Pi会话自动命名扩展开发");
    const resumed = await create(restoredManager, true);
    await resumed.prompt("恢复后的问题"); await delay(50);
    assert.equal(requests.filter((request) => request.model === "title").length, 1);
    assert.deepEqual(errors, []);
  } finally {
    for (const session of sessions) session.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
