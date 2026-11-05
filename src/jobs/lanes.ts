/** In-process serializers: one call at a time per lane, in the order they came, a failure not blocking the next. */

export type Lane = <T>(fn: () => Promise<T>) => Promise<T>;

export function lane(): Lane {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** One lane per key, made on first use. */
export function lanes<K>(): (key: K) => Lane {
  const all = new Map<K, Lane>();
  return (key) => {
    let l = all.get(key);
    if (!l) all.set(key, (l = lane()));
    return l;
  };
}

/**
 * Many readers or one writer. A writer waits for the reads in flight and holds new ones until it
 * ends; writers go in the order they came. Meant for one file read or write, never a model turn.
 */
export function gate(): { readonly read: Lane; readonly write: Lane } {
  let writers = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const reads = new Set<Promise<unknown>>();
  return {
    async read(fn) {
      while (writers > 0) await tail;
      const run = fn();
      reads.add(run);
      try {
        return await run;
      } finally {
        reads.delete(run);
      }
    },
    write(fn) {
      writers += 1;
      const run = tail
        .then(() => Promise.allSettled([...reads]))
        .then(fn)
        .finally(() => void (writers -= 1));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
