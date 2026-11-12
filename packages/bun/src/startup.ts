/** Times the steps of the browser's start, so a slow or failed one says where the time went. */
export class StartupSteps {
  #done: { name: string; ms: number }[] = [];

  async run<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.#done.push({ name, ms: performance.now() - started });
    }
  }

  get totalMs(): number {
    return this.#done.reduce((sum, step) => sum + step.ms, 0);
  }

  summary(): string {
    return this.#done.map((step) => `${step.name} ${seconds(step.ms)}`).join(", ");
  }
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
