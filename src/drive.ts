import { AsyncExtensionError } from "./errors";
import { isThenable } from "./json";

/** A pending asynchronous step yielded by a generator based algorithm. */
export interface Pending {
  promise: PromiseLike<unknown>;
  what: string;
}

export type Job<T> = Generator<Pending, T, unknown>;

/**
 * AppNav's builders and runtime are written once as generators and driven in
 * two ways, so the sync and async APIs share one implementation and cannot
 * drift apart. The sync driver rejects any step that yields a promise.
 */
export function driveSync<T>(job: Job<T>): T {
  let r = job.next();
  while (!r.done) {
    const pending = r.value;
    if (isThenable(pending.promise)) {
      pending.promise.then(undefined, () => undefined); // avoid unhandled rejection noise
      throw new AsyncExtensionError(pending.what);
    }
    r = job.next(pending.promise);
  }
  return r.value;
}

export async function driveAsync<T>(job: Job<T>): Promise<T> {
  let r = job.next();
  while (!r.done) {
    try {
      const v = await r.value.promise;
      r = job.next(v);
    } catch (e) {
      r = job.throw(e);
    }
  }
  return r.value;
}
