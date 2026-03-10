import type { ServerAdapter } from "./types.js";

export type RuntimeName = "node" | "bun" | "deno";

export function detectRuntime(): RuntimeName {
  if (typeof globalThis !== "undefined") {
    if ("Bun" in globalThis) return "bun";
    if ("Deno" in globalThis) return "deno";
  }
  return "node";
}

export async function resolveAdapter(
  option?: RuntimeName | ServerAdapter
): Promise<ServerAdapter> {
  if (option && typeof option === "object") return option;

  const runtime = option ?? detectRuntime();
  switch (runtime) {
    case "bun": {
      console.log("[AdapterResolver] Using Bun adapter");
      const { bunAdapter } = await import("./bun.js");
      return bunAdapter;
    }
    case "deno": {
      console.log("[AdapterResolver] Using Deno adapter");
      const { denoAdapter } = await import("./deno.js");
      return denoAdapter;
    }
    case "node":
    default: {
      console.log("[AdapterResolver] Using Node adapter");
      const { nodeAdapter } = await import("./node.js");
      return nodeAdapter;
    }
  }
}
