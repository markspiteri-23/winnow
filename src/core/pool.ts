import os from "node:os";
import { Worker } from "node:worker_threads";
import type { Metrics, MetricsInput } from "./metrics.ts";
import type { FileError } from "./types.ts";
import { weight } from "./weights.ts";

export interface PoolTask {
  id: number;
  input: MetricsInput;
}

export type PoolReply = { id: number; metrics: Metrics } | { id: number; error: string };

export interface PoolOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Called as each shot finishes, before the run ends (used to cache results so a cancelled run resumes). */
  onResult?: (m: Metrics) => void;
}

export interface PoolResult {
  metrics: Metrics[];
  errors: FileError[];
  /** True when the signal fired: `metrics` holds what finished before it. */
  cancelled: boolean;
}

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(weight("poolConcurrency"), os.availableParallelism() - 1));
}

/**
 * Measures previews in worker threads, never on the main thread. A failure on one shot (bad file, or a crashed
 * worker) is recorded and never aborts the run; a crashed worker is replaced.
 */
export function measureInPool(inputs: MetricsInput[], opts: PoolOptions = {}): Promise<PoolResult> {
  const total = inputs.length;
  const size = Math.max(1, Math.min(opts.concurrency ?? defaultConcurrency(), total));
  const metrics: Metrics[] = [];
  const errors: FileError[] = [];
  if (total === 0) return Promise.resolve({ metrics, errors, cancelled: false });

  return new Promise((resolve) => {
    let next = 0;
    let done = 0;
    let finished = false;
    const workers = new Set<Worker>();
    const busy = new Map<Worker, number>();

    const finish = (cancelled: boolean): void => {
      if (finished) return;
      finished = true;
      opts.signal?.removeEventListener("abort", onAbort);
      for (const w of workers) void w.terminate();
      resolve({ metrics, errors, cancelled });
    };
    const onAbort = (): void => finish(true);

    const settle = (w: Worker, reply: PoolReply, alive = true): void => {
      busy.delete(w);
      const input = inputs[reply.id]!;
      if ("metrics" in reply) {
        metrics.push(reply.metrics);
        try {
          opts.onResult?.(reply.metrics);
        } catch (err) {
          errors.push({ path: input.shotId, error: `cache: ${err instanceof Error ? err.message : String(err)}` });
        }
      } else errors.push({ path: input.shotId, error: reply.error });
      done++;
      opts.onProgress?.(done, total);
      if (done === total) finish(false);
      else if (alive) feed(w);
    };

    const feed = (w: Worker): void => {
      if (finished || next >= total) return;
      const id = next++;
      busy.set(w, id);
      w.postMessage({ id, input: inputs[id]! } satisfies PoolTask);
    };

    const spawn = (): void => {
      const w = new Worker(new URL("./metrics-worker.ts", import.meta.url));
      workers.add(w);
      w.on("message", (reply: PoolReply) => settle(w, reply));
      w.on("error", (err) => {
        workers.delete(w);
        const id = busy.get(w);
        if (finished) return;
        if (id !== undefined) settle(w, { id, error: `worker crashed: ${err.message}` }, false);
        if (!finished && next < total) spawn();
      });
      feed(w);
    };

    if (opts.signal?.aborted) return finish(true);
    opts.signal?.addEventListener("abort", onAbort);
    for (let i = 0; i < size; i++) spawn();
  });
}
