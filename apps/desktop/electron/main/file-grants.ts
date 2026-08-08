import { basename, isAbsolute, normalize, resolve } from "node:path";
import { open } from "node:fs/promises";
import type { CoreAdminClient } from "./core-admin-client.js";

export interface RendererFileGrant {
  grant_id: string;
  display_name: string;
  size_bytes: number;
  modified_at: string;
}

export async function registerFileGrant(core: CoreAdminClient, inputPath: string): Promise<RendererFileGrant> {
  if (!isAbsolute(inputPath)) throw new Error("Only absolute file paths can be registered");
  const resolved = normalize(resolve(inputPath));
  const file = await open(resolved, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Only regular files can be registered");
    return await core.registerFile(resolved) as RendererFileGrant;
  } finally {
    await file.close();
  }
}

export function displayName(inputPath: string): string {
  return basename(inputPath);
}
