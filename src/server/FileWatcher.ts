import fs from "node:fs";
import path from "node:path";

export interface FileWatcherOptions {
  functionsDir: string;
  watchSharedFolders: boolean;
}

export class FileWatcher {
  #options: FileWatcherOptions;
  #watcher: fs.FSWatcher | undefined;
  #debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: FileWatcherOptions) {
    this.#options = options;
  }

  start(
    onFunctionChange: (name: string) => Promise<void>,
    onSharedChange: () => Promise<void>
  ): void {
    this.#watcher = fs.watch(
      this.#options.functionsDir,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        // filename is relative to functionsDir, e.g. "hello/index.ts" or "_shared/cors.ts"
        const topDir = filename.split(path.sep)[0]!;
        const isSharedChange = topDir.startsWith("_");

        // Skip shared folder changes if watchSharedFolders is disabled
        if (isSharedChange && !this.#options.watchSharedFolders) return;

        // Debounce key: use the top-level dir for function changes,
        // use "__shared__" for all shared changes (so they coalesce)
        const debounceKey = isSharedChange ? "__shared__" : topDir;

        const existing = this.#debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        this.#debounceTimers.set(
          debounceKey,
          setTimeout(async () => {
            this.#debounceTimers.delete(debounceKey);

            if (isSharedChange) {
              await onSharedChange();
            } else {
              await onFunctionChange(topDir);
            }
          }, 200)
        );
      }
    );
  }

  stop(): void {
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = undefined;
    }
    for (const timer of this.#debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.#debounceTimers.clear();
  }
}
