import { describe, expect, test } from "bun:test";
import { Slot } from "./slot";

const deferred = <T>() => Promise.withResolvers<T>();

describe("Slot", () => {
  /** Catches the deadlock the lanes exist for: an interception answer queued behind a page call that waits on
   *  the very request it answers. */
  test("answers go before queued page calls, and page calls wait while the page is held", async () => {
    let held = true;
    const slot = new Slot("test", () => held);
    const order: string[] = [];
    const page = slot.call("page", "query", async () => void order.push("page"));
    const answer = slot.call("answer", "answer", async () => void order.push("answer"));
    await answer;
    expect(order).toEqual(["answer"]);
    held = false;
    slot.pump();
    await page;
    expect(order).toEqual(["answer", "page"]);
  });

  test("when the slot frees, a queued answer goes before a page call queued earlier", async () => {
    const slot = new Slot("test");
    const blocker = deferred<void>();
    const order: string[] = [];
    const busy = slot.call("page", "busy", () => blocker.promise);
    const page = slot.call("page", "query", async () => void order.push("page"));
    const answer = slot.call("answer", "answer", async () => void order.push("answer"));
    blocker.resolve();
    await Promise.all([busy, page, answer]);
    expect(order).toEqual(["answer", "page"]);
  });

  test("one call at a time", async () => {
    const slot = new Slot("test");
    const first = deferred<void>();
    let running = 0;
    let most = 0;
    const call = (work: Promise<void>) =>
      slot.call("page", "call", async () => {
        most = Math.max(most, ++running);
        await work;
        running--;
      });
    const a = call(first.promise);
    const b = call(Promise.resolve());
    await Bun.sleep(5);
    expect(running).toBe(1);
    first.resolve();
    await Promise.all([a, b]);
    expect(most).toBe(1);
  });

  /** Catches a timed-out test's call running on the next test's page. */
  test("a call whose guard throws is cancelled before it is sent", async () => {
    const slot = new Slot("test");
    let sent = false;
    const call = slot.call(
      "page",
      "query",
      async () => void (sent = true),
      () => {
        throw new Error("stale");
      },
    );
    await expect(call).rejects.toThrow("stale");
    expect(sent).toBe(false);
  });

  test("drop fails every queued call", async () => {
    const slot = new Slot("test", () => true);
    const call = slot.call("page", "query", async () => {});
    slot.drop("the view was replaced");
    await expect(call).rejects.toThrow("the view was replaced");
    expect(slot.idle).toBe(true);
  });
});
