type Waiter<T> = {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export const createWaiterRegistry = <K, T>() => {
  const waiters = new Map<K, Set<Waiter<T>>>();

  const remove = (key: K, waiter: Waiter<T>) => {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    const entries = waiters.get(key);
    entries?.delete(waiter);
    if (entries?.size === 0) waiters.delete(key);
  };

  const register = (key: K, timeoutMs: number, signal?: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject, signal };
      const finish = (callback: () => void) => {
        remove(key, waiter);
        callback();
      };
      waiter.onAbort = () => finish(() => reject(new Error("等待已取消")));
      if (signal?.aborted) return waiter.onAbort();
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      const entries = waiters.get(key) ?? new Set<Waiter<T>>();
      entries.add(waiter);
      waiters.set(key, entries);
      waiter.timer = setTimeout(() => finish(() => reject(new Error("等待超时"))), timeoutMs);
    });

  const notifyFirst = (key: K, value: T): boolean => {
    const waiter = waiters.get(key)?.values().next().value as Waiter<T> | undefined;
    if (!waiter) return false;
    remove(key, waiter);
    waiter.resolve(value);
    return true;
  };

  const notifyAll = (key: K, value: T): number => {
    const entries = [...(waiters.get(key) ?? [])];
    entries.forEach((waiter) => {
      remove(key, waiter);
      waiter.resolve(value);
    });
    return entries.length;
  };

  const notifyFirstAndClear = (key: K, value: T, reason: unknown): boolean => {
    const notified = notifyFirst(key, value);
    clear(key, reason);
    return notified;
  };

  const clear = (key: K, reason: unknown): number => {
    const entries = [...(waiters.get(key) ?? [])];
    entries.forEach((waiter) => {
      remove(key, waiter);
      waiter.reject(reason);
    });
    return entries.length;
  };

  return {
    register,
    notifyFirst,
    notifyAll,
    notifyFirstAndClear,
    clear,
    count: (key?: K) => key === undefined ? [...waiters.values()].reduce((total, set) => total + set.size, 0) : waiters.get(key)?.size ?? 0,
  };
};
