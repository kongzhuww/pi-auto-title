import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { FileConfigStore } from "./config.ts";
import { registerAutoTitle } from "./extension.ts";

export default function autoTitle(pi: ExtensionAPI): void {
  registerAutoTitle(pi, new FileConfigStore(join(getAgentDir(), "auto-title.json")));
}
