import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConfigStore, parseConfig } from "../src/config.ts";

test("validates configuration and fails closed on malformed or unsupported data", () => {
  for (const value of [null, {}, { version: 2, model: null }, { version: 1, model: {} }, { version: 1, model: { provider: "", modelId: "x" } }]) {
    assert.throws(() => parseConfig(value));
  }
  assert.deepEqual(parseConfig({ version: 1, model: null }), { version: 1, model: null });
});

test("missing configuration is disabled; atomic replacement persists across reloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-title-test-"));
  try {
    const path = join(root, "profile", "auto-title.json");
    const store = new FileConfigStore(path);
    assert.deepEqual(await store.load(), { version: 1, model: null });
    const value = { version: 1 as const, model: { provider: "configured-provider", modelId: "gemini-model-id" } };
    await store.save(value);
    assert.deepEqual(await new FileConfigStore(path).load(), value);
    await store.save({ version: 1, model: null });
    assert.equal((await store.load()).model, null);
    assert.deepEqual(await readdir(join(root, "profile")), ["auto-title.json"]);
    assert.ok(!(await readFile(path, "utf8")).includes("apiKey"));
    await writeFile(path, "{invalid");
    await assert.rejects(store.load());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("different active profile directories never share model selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-title-profiles-"));
  try {
    const a = new FileConfigStore(join(root, "a", "auto-title.json"));
    const b = new FileConfigStore(join(root, "b", "auto-title.json"));
    await a.save({ version: 1, model: { provider: "provider-a", modelId: "model-a" } });
    assert.equal((await b.load()).model, null);
    await b.save({ version: 1, model: { provider: "provider-b", modelId: "model-b" } });
    assert.equal((await a.load()).model?.provider, "provider-a");
    assert.equal((await b.load()).model?.provider, "provider-b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
