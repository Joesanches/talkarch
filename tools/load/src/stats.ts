/** Перцентили по выборке задержек (мс). */
export interface Summary {
  n: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export function summarize(samples: number[], errors = 0): Summary {
  const s = [...samples].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x);
  return {
    n: s.length,
    errors,
    p50: r(percentile(s, 50)),
    p95: r(percentile(s, 95)),
    p99: r(percentile(s, 99)),
    max: r(s.at(-1) ?? NaN),
    mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
}

export class Recorder {
  readonly samples: number[] = [];
  errors = 0;
  readonly errorKinds = new Map<string, number>();

  ok(ms: number) {
    this.samples.push(ms);
  }

  fail(kind: string) {
    this.errors += 1;
    this.errorKinds.set(kind, (this.errorKinds.get(kind) ?? 0) + 1);
  }

  summary(): Summary & { errorKinds?: Record<string, number> } {
    return { ...summarize(this.samples, this.errors), ...(this.errorKinds.size ? { errorKinds: Object.fromEntries(this.errorKinds) } : {}) };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Выполнить задачи с ограничением параллельности. */
export async function pool<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}

/**
 * Открытая модель нагрузки: запуск задач с постоянной частотой, не дожидаясь предыдущих.
 * Так задержка сервера не снижает подаваемую нагрузку (нет «согласованного пропуска»).
 */
export async function paced(count: number, perSecond: number, fn: (i: number) => Promise<void>) {
  const start = performance.now();
  const running: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const due = start + (i * 1000) / perSecond;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    running.push(fn(i));
  }
  await Promise.all(running);
  return (performance.now() - start) / 1000;
}
