import { AsyncLocalStorage } from "node:async_hooks";
import { JmapError } from "./errors.js";

// Whether the client still waits for the request being answered. A webmail
// closes a search when the user opens a folder; without this the proxy kept
// searching every folder, on connections the folder then waited for.

const storage = new AsyncLocalStorage<AbortSignal>();

/** Run `work` so that the reads in it can stop once `signal` aborts. */
export const runAbortable = <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => storage.run(signal, work);

/** Throws once the client closed the request. */
export function throwIfClientGone(): void {
  if (storage.getStore()?.aborted) throw new JmapError("serverUnavailable", "the client closed the request");
}
