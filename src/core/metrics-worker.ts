// Worker thread: measures one preview per message. Loaded as .ts by Node's own type stripping (Node 24), so this file
// and everything it imports must use erasable TypeScript only (no enums, no parameter properties).
import { parentPort } from "node:worker_threads";
import { measureShot, type MetricsInput } from "./metrics.ts";
import type { PoolReply, PoolTask } from "./pool.ts";

parentPort!.on("message", (task: PoolTask) => {
  measureShot(task.input satisfies MetricsInput).then(
    (metrics) => parentPort!.postMessage({ id: task.id, metrics } satisfies PoolReply),
    (err: unknown) => parentPort!.postMessage({ id: task.id, error: err instanceof Error ? err.message : String(err) } satisfies PoolReply),
  );
});
