/** Bounded-concurrency map that never rejects: every slot resolves to ok|err. */
export async function pooledMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onSettle?: (item: T, index: number, result: { ok: true; value: R } | { ok: false; error: Error }) => void,
): Promise<({ ok: true; value: R } | { ok: false; error: Error })[]> {
  const out: ({ ok: true; value: R } | { ok: false; error: Error })[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = { ok: true, value: await fn(items[i]!, i) };
      } catch (err) {
        out[i] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      }
      onSettle?.(items[i]!, i, out[i]!);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}
