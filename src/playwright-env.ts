// playwright-core caches PLAYWRIGHT_BROWSERS_PATH at module load — must be set
// before the import graph resolves it. Loaded as a bunfig preload.
import path from "node:path";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(
  import.meta.dir,
  "../do_not_commit/playwright-browsers"
);
