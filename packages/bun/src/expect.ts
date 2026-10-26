import { expect as bunExpect, type Matchers } from "bun:test";
import { type Locator, LocatorImpl } from "./page";

const ASSERT_TIMEOUT_MS = 15_000;

/** The assertions on a {@link Locator}: each retries for up to 15 s, so each must be awaited. */
export interface LocatorMatchers {
  toBeVisible(): Promise<void>;
  toBeAttached(): Promise<void>;
  toHaveCount(count: number): Promise<void>;
  toBeDisabled(): Promise<void>;
  toHaveValue(value: string): Promise<void>;
  toHaveAttribute(name: string, value: string): Promise<void>;
}

export interface LocatorAssertions extends LocatorMatchers {
  /** The same assertions, waiting for the opposite. */
  readonly not: LocatorMatchers;
}

const js = (value: unknown) => JSON.stringify(value);

class Assertions implements LocatorAssertions {
  constructor(
    private readonly locator: LocatorImpl,
    private readonly negated: boolean,
  ) {}

  get not(): LocatorMatchers {
    return new Assertions(this.locator, !this.negated);
  }

  async #until(matcher: string, holds: () => Promise<boolean>): Promise<void> {
    const assertion = `expect(${this.locator})${this.negated ? ".not" : ""}.${matcher}`;
    await this.locator.page.waitUntil(assertion, async () => (await holds()) !== this.negated, ASSERT_TIMEOUT_MS);
    // Counted by bun:test, so `expect.assertions(n)` and `expect.hasAssertions()` see it.
    bunExpect(true).toBe(true);
  }

  async #state(
    matcher: string,
    holds: (state: { disabled: boolean; value: string | null; attributes: Record<string, string> }) => boolean,
  ): Promise<void> {
    // Both ways round, the element must exist: `.not.toBeDisabled()` on a locator that matches nothing fails.
    await this.#until(matcher, async () => {
      const state = await this.locator.state();
      return state === null ? this.negated : holds(state);
    });
  }

  toBeVisible(): Promise<void> {
    return this.#until("toBeVisible()", () => this.locator.isVisible());
  }

  toBeAttached(): Promise<void> {
    return this.#until("toBeAttached()", async () => (await this.locator.count()) > 0);
  }

  toHaveCount(count: number): Promise<void> {
    return this.#until(`toHaveCount(${count})`, async () => (await this.locator.count()) === count);
  }

  toBeDisabled(): Promise<void> {
    return this.#state("toBeDisabled()", (state) => state.disabled);
  }

  toHaveValue(value: string): Promise<void> {
    return this.#state(`toHaveValue(${js(value)})`, (state) => state.value === value);
  }

  toHaveAttribute(name: string, value: string): Promise<void> {
    return this.#state(`toHaveAttribute(${js(name)}, ${js(value)})`, (state) => state.attributes[name] === value);
  }
}

function locatorExpect(actual: Locator): LocatorAssertions;
function locatorExpect<T = unknown>(actual?: T, customFailMessage?: string): Matchers<T>;
function locatorExpect(actual?: unknown, customFailMessage?: string): LocatorAssertions | Matchers<unknown> {
  return actual instanceof LocatorImpl ? new Assertions(actual, false) : bunExpect(actual, customFailMessage);
}

/** `bun:test`'s `expect`, with the retrying {@link LocatorAssertions} for a {@link Locator}. */
export type Expect = typeof locatorExpect & typeof bunExpect;

/** `bun:test`'s `expect` with a {@link Locator} overload in front: `await expect(page.getByText("Saved"))
 *  .toBeVisible()` retries until it holds; any other value, and every static (`expect.any`,
 *  `expect.assertions`, …), is bun's own. */
export const expect: Expect = Object.assign(locatorExpect, bunExpect);
