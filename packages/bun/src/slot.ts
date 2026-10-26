/** How long one call to the browser may take, and how long a call may wait for its turn. */
export const CALL_TIMEOUT_MS = 15_000;

/** Which queue a call joins. `answer` (request-interception answers) always goes first and `reset` next;
 *  both run while the page is held. `page` calls wait while {@link Slot}'s `held()` is true. A call that
 *  can't start within {@link CALL_TIMEOUT_MS} fails, whatever its lane. */
export type Lane = "answer" | "reset" | "page";

interface Task {
  label: string;
  /** Throws to cancel the call before it is sent (a test that has since timed out). */
  guard: () => void;
  run: () => Promise<void>;
  reject: (error: Error) => void;
  waitTimer?: ReturnType<typeof setTimeout>;
}

/**
 * One of `Bun.WebView`'s per-view slots (CDP commands, `evaluate`, native input), each of which takes one
 * call at a time: a second concurrent call fails. Calls queue here instead, answers first.
 *
 * A call that times out rejects its caller, but the slot stays taken until the browser actually answers:
 * sending the next call into a slot still in use would fail. The reset waits for the CDP and input slots to
 * go idle, and replaces the view when one doesn't.
 */
export class Slot {
  #queues: Record<Lane, Task[]> = { answer: [], reset: [], page: [] };
  #busy = false;

  constructor(
    private readonly name: string,
    private readonly held: () => boolean = () => false,
  ) {}

  get idle(): boolean {
    return !this.#busy && !this.#queues.answer.length && !this.#queues.reset.length && !this.#queues.page.length;
  }

  call<T>(lane: Lane, label: string, send: () => Promise<T>, guard: () => void = () => {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: Task = { label, guard, run: () => Promise.resolve().then(send).then(resolve, reject), reject };
      // Bounded for every lane: behind a call the browser never answers, nothing else is ever sent.
      task.waitTimer = setTimeout(() => {
        const queue = this.#queues[lane];
        const at = queue.indexOf(task);
        if (at === -1) return;
        queue.splice(at, 1);
        const why = this.#busy ? "behind a call the browser hasn't answered" : "for the page to finish loading";
        reject(new Error(`${label} waited ${CALL_TIMEOUT_MS / 1000}s ${why}`));
      }, CALL_TIMEOUT_MS);
      this.#queues[lane].push(task);
      this.pump();
    });
  }

  /** Run the next call, if the slot is free and one may go. Called again whenever the page stops being held. */
  pump(): void {
    while (!this.#busy) {
      const { answer, reset, page } = this.#queues;
      const task = answer.shift() ?? reset.shift() ?? (this.held() ? undefined : page.shift());
      if (!task) return;
      clearTimeout(task.waitTimer);
      try {
        task.guard();
      } catch (error) {
        task.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      this.#busy = true;
      const timer = setTimeout(() => {
        task.reject(new Error(`${task.label} got no answer from the browser within ${CALL_TIMEOUT_MS / 1000}s`));
      }, CALL_TIMEOUT_MS);
      void task.run().finally(() => {
        clearTimeout(timer);
        this.#busy = false;
        this.pump();
      });
    }
  }

  /** Fail every queued call: the view they were meant for is gone. */
  drop(reason: string): void {
    for (const queue of Object.values(this.#queues)) {
      for (const task of queue.splice(0)) {
        clearTimeout(task.waitTimer);
        task.reject(new Error(`${task.label}: ${reason} (${this.name})`));
      }
    }
  }
}
