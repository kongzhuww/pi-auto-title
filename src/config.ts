import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface TitleModel {
  provider: string;
  modelId: string;
}

export interface TitleConfig {
  version: 1;
  model: TitleModel | null;
}

export interface ConfigStore {
  load(): Promise<TitleConfig>;
  save(config: TitleConfig): Promise<void>;
}

export function parseConfig(value: unknown): TitleConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid auto-title configuration");
  const config = value as Record<string, unknown>;
  if (config.version !== 1) throw new Error("Unsupported auto-title configuration version");
  if (config.model === null) return { version: 1, model: null };
  const model = config.model as Record<string, unknown> | undefined;
  if (!model || typeof model.provider !== "string" || !model.provider.trim() ||
      typeof model.modelId !== "string" || !model.modelId.trim()) {
    throw new Error("Invalid auto-title model selection");
  }
  return { version: 1, model: { provider: model.provider, modelId: model.modelId } };
}

export class FileConfigStore implements ConfigStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<TitleConfig> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, model: null };
      throw error;
    }
    return parseConfig(JSON.parse(raw.replace(/^\uFEFF/, "")));
  }

  async save(config: TitleConfig): Promise<void> {
    const validated = parseConfig(config);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(validated, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
