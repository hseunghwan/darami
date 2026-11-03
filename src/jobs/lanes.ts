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
