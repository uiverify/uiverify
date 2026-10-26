import { StaleTestError } from "./context";
import { PAGE_HELPERS_GLOBAL } from "./page/protocol";
import type { RouteHandler, RoutePattern } from "./routes";
import type { Tab } from "./tab";

const H = PAGE_HELPERS_GLOBAL;
const WAIT_TIMEOUT_MS = 15_000;

export interface RoleOptions {
  /** The accessible name: a substring, case-insensitive, unless `exact`; or a RegExp. */
  name?: string | RegExp;
  exact?: boolean;
  checked?: boolean;
  selected?: boolean;
  pressed?: boolean;
}

export interface TextOptions {
  /** Match the whole text, case-sensitive. Otherwise a case-insensitive substring. */
  exact?: boolean;
}

/** The ways to find elements, the same on a {@link Page} and, within it, a {@link Locator}. */
export interface Finders {
  /** A CSS selector, optionally ending in Playwright's `:text-is("…")`; `".."` is the parent. */
  locator(selector: string): Locator;
  /** By ARIA role, from Chrome's accessibility tree. */
  getByRole(role: string, options?: RoleOptions): Locator;
  getByText(text: string, options?: TextOptions): Locator;
  /** A form control by its label: `<label for>`, a wrapping `<label>`, `aria-labelledby` or `aria-label`. */
  getByLabel(text: string, options?: TextOptions): Locator;
  getByPlaceholder(text: string, options?: TextOptions): Locator;
  /** By `data-testid`. */
  getByTestId(testId: string): Locator;
}

/** Elements on the page, found afresh each time it's used, so a re-rendered element is found again. Actions
 *  wait up to 15 s for the first visible match. */
export interface Locator extends Finders {
  first(): Locator;
  click(options?: { button?: "left" | "right" }): Promise<void>;
  hover(): Promise<void>;
  /** Replace the field's text with `text`. */
  fill(text: string): Promise<void>;
  /** Remove every match from the page, once there is one. */
  remove(): Promise<void>;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
}

/** The test's browser tab. Fresh for each test: blank, no routes or init scripts, cleared storage. */
export interface Page extends Finders {
  /** Open `url`, relative to the suite's base URL; resolves once the page has loaded. */
  goto(url: string): Promise<void>;
  /** Answer the requests whose URL matches `pattern`, latest-registered first. Register before `goto`: a
   *  second `goto` in one test may take assets from the memory cache. */
  route(pattern: RoutePattern, handler: RouteHandler): void;
  /** Run `script` in every document this test opens, before the page's own scripts. It is sent as source,
   *  so it can't use variables from around it. */
  addInitScript(script: () => unknown): Promise<void>;
  addStyleTag(style: { content: string }): Promise<void>;
  /** Stop the page's clock: `Date` stands still and timers wait until {@link resumeClock}. */
  pauseClock(): Promise<void>;
  resumeClock(): Promise<void>;
  /** Poll `check` until it returns true (default timeout 15 s), failing with `description`. */
  waitUntil(description: string, check: () => Promise<boolean> | boolean, timeout?: number): Promise<void>;
}

type Step =
  | { kind: "css"; selector: string; textIs?: string }
  | { kind: "text"; text: string; exact: boolean }
  | { kind: "placeholder"; text: string; exact: boolean }
  | { kind: "label"; text: string; exact: boolean }
  | ({ kind: "role"; role: string } & RoleOptions)
  | { kind: "parent" }
  | { kind: "first" };

interface AXNode {
  ignored: boolean;
  role?: { value?: string };
  name?: { value?: string; sources?: AXSource[] };
  backendDOMNodeId?: number;
  properties?: { name: string; value: { value?: unknown } }[];
}

interface AXSource {
  type: string;
  value?: { value?: unknown };
  attribute?: string;
  nativeSource?: string;
  superseded?: boolean;
}

const js = (value: unknown) => (value === undefined ? "undefined" : JSON.stringify(value));
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

/** Playwright's name matching: a substring, case-insensitive and whitespace-normalized, unless exact. */
export function nameMatches(name: string, expected: string | RegExp | undefined, exact = false): boolean {
  if (expected === undefined) return true;
  // A copy without `g`/`y`, whose `lastIndex` would skip every other match.
  if (expected instanceof RegExp) return new RegExp(expected.source, expected.flags.replace(/[gy]/g, "")).test(name);
  const actual = normalize(name);
  return exact ? actual === normalize(expected) : actual.toLowerCase().includes(normalize(expected).toLowerCase());
}

/** Whether an accessibility node is named by a label association rather than its own text. */
function namedByLabel(node: AXNode): boolean {
  const used = node.name?.sources?.find((source) => source.value?.value !== undefined && !source.superseded);
  if (!used) return false;
  if (used.attribute === "aria-labelledby" || used.attribute === "aria-label") return true;
  return used.nativeSource === "label" || used.nativeSource === "labelfor" || used.nativeSource === "labelwrapped";
}

function parseSelector(selector: string): Step {
  if (selector === "..") return { kind: "parent" };
  const textIs = /^(.*):text-is\("(.*)"\)$/.exec(selector);
  return textIs ? { kind: "css", selector: textIs[1] || "*", textIs: textIs[2] } : { kind: "css", selector };
}

export class PageImpl implements Page {
  #lock: Promise<unknown> = Promise.resolve();
  #pendingInitScripts = new Set<Promise<unknown>>();

  constructor(readonly tab: Tab) {}

  #root(): LocatorImpl {
    return new LocatorImpl(this, []);
  }

  locator(selector: string): Locator {
    return this.#root().locator(selector);
  }
  getByRole(role: string, options?: RoleOptions): Locator {
    return this.#root().getByRole(role, options);
  }
  getByText(text: string, options?: TextOptions): Locator {
    return this.#root().getByText(text, options);
  }
  getByLabel(text: string, options?: TextOptions): Locator {
    return this.#root().getByLabel(text, options);
  }
  getByPlaceholder(text: string, options?: TextOptions): Locator {
    return this.#root().getByPlaceholder(text, options);
  }
  getByTestId(testId: string): Locator {
    return this.#root().getByTestId(testId);
  }

  async goto(url: string): Promise<void> {
    // A registration a timed-out test made fails its generation check, which isn't this test's failure.
    for (const settled of await Promise.allSettled(this.#pendingInitScripts)) {
      if (settled.status === "rejected" && !(settled.reason instanceof StaleTestError)) throw settled.reason;
    }
    await this.tab.navigate(this.#resolve(url));
  }

  #resolve(url: string): string {
    if (/^[a-z][a-z\d+.-]*:/i.test(url)) return url;
    if (this.tab.baseUrl === undefined) {
      throw new Error(`@uiverify/bun: goto("${url}") is relative, but this suite has no base URL.`);
    }
    return new URL(url, this.tab.baseUrl).href;
  }

  route(pattern: RoutePattern, handler: RouteHandler): void {
    this.tab.assertCurrent("route");
    this.tab.router.add(pattern, handler, this.tab.baseUrl);
  }

  addInitScript(script: () => unknown): Promise<void> {
    const registering = this.tab.addInitScript(`(${script.toString()})();`);
    this.#pendingInitScripts.add(registering);
    void registering.finally(() => this.#pendingInitScripts.delete(registering)).catch(() => {});
    return registering;
  }

  async addStyleTag({ content }: { content: string }): Promise<void> {
    await this.tab.evaluate(`${H}.addStyle(${js(content)})`);
  }

  async pauseClock(): Promise<void> {
    await this.tab.evaluate(`${H}.pause()`);
  }

  async resumeClock(): Promise<void> {
    await this.tab.evaluate(`${H}.resume()`);
  }

  async waitUntil(
    description: string,
    check: () => Promise<boolean> | boolean,
    timeout = WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    for (;;) {
      try {
        // Bounded too: a check that never settles must not outlast the timeout.
        let expire: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<"expired">((resolve) => {
          expire = setTimeout(() => resolve("expired"), Math.max(0, deadline - Date.now()));
        });
        const result = await Promise.race([Promise.resolve(check()), expired]).finally(() => clearTimeout(expire));
        if (result === true) return;
        lastError = undefined;
      } catch (error) {
        if (error instanceof StaleTestError) throw error;
        lastError = error;
      }
      if (Date.now() > deadline) {
        const cause = lastError === undefined ? "" : ` (the last check threw: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
        throw new Error(`@uiverify/bun: timed out after ${timeout / 1000}s waiting for ${description}${cause}`);
      }
      await Bun.sleep(50);
    }
  }

  /** One attempt of a locator action at a time, so a concurrent `click` and `fill` can't interleave. */
  withLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(work, work);
    this.#lock = run.catch(() => {});
    return run;
  }

  /** Waits for the locator's first visible match and acts on it; retried while the element is replaced
   *  under it. Then waits out a navigation the action started. */
  async act(locator: LocatorImpl, what: string, action: (ref: string) => Promise<unknown>): Promise<void> {
    let lastError: unknown;
    await this.waitUntil(`${locator} to be visible, to ${what} it`, () =>
      this.withLock(async () => {
        for (const ref of await locator.resolve()) {
          if (!(await this.tab.evaluate<boolean>(`${H}.visible(${js(ref)})`))) continue;
          try {
            await action(ref);
            return true;
          } catch (error) {
            if (error instanceof StaleTestError) throw error;
            lastError = error;
          }
        }
        return false;
      }),
    ).catch((error: unknown) => {
      throw error instanceof StaleTestError ? error : (lastError ?? error);
    });
    await this.tab.afterAction();
  }

  /** Mark the elements `steps` match and return their marks. */
  async resolve(steps: Step[]): Promise<string[]> {
    let refs: string[] | null = null;
    for (const step of steps) {
      if (step.kind === "css") {
        refs = await this.tab.evaluate<string[]>(`${H}.css(${js(refs)}, ${js(step.selector)}, ${js(step.textIs)})`);
      } else if (step.kind === "text") {
        refs = await this.tab.evaluate<string[]>(`${H}.text(${js(refs)}, ${js(step.text)}, ${js(step.exact)})`);
      } else if (step.kind === "placeholder") {
        refs = await this.tab.evaluate<string[]>(`${H}.placeholder(${js(refs)}, ${js(step.text)}, ${js(step.exact)})`);
      } else if (step.kind === "parent") {
        refs = await this.tab.evaluate<string[]>(`${H}.parent(${js(refs ?? [])})`);
      } else if (step.kind === "first") {
        refs = (refs ?? []).slice(0, 1);
      } else {
        refs = await this.#byAccessibility(refs, step);
      }
    }
    return refs ?? [];
  }

  async #objectId(expression: string): Promise<string | undefined> {
    const { result } = await this.tab.cdp<{ result: { objectId?: string } }>("page", "Runtime.evaluate", { expression });
    return result.objectId;
  }

  /** Role and label queries, answered by Chrome's accessibility tree. */
  async #byAccessibility(refs: string[] | null, step: Extract<Step, { kind: "role" | "label" }>): Promise<string[]> {
    const roots =
      refs === null
        ? [await this.#objectId("document")]
        : await Promise.all(refs.map((ref) => this.#objectId(`${H}.byRef(${js(ref)})`)));
    const marked: string[] = [];
    for (const objectId of roots) {
      if (!objectId) continue;
      // The tree's `accessibleName` filter is exact-only, so names are matched here.
      const { nodes } = await this.tab.cdp<{ nodes: AXNode[] }>("page", "Accessibility.queryAXTree", {
        objectId,
        ...(step.kind === "role" ? { role: step.role } : {}),
      });
      for (const node of nodes) {
        if (node.ignored || node.backendDOMNodeId === undefined) continue;
        const name = node.name?.value ?? "";
        if (step.kind === "label") {
          if (!nameMatches(name, step.text, step.exact) || !namedByLabel(node)) continue;
        } else {
          if (!nameMatches(name, step.name, step.exact)) continue;
          const property = (key: string) => node.properties?.find((p) => p.name === key)?.value.value;
          if (step.checked !== undefined && String(property("checked")) !== String(step.checked)) continue;
          if (step.selected !== undefined && String(property("selected")) !== String(step.selected)) continue;
          if (step.pressed !== undefined && String(property("pressed")) !== String(step.pressed)) continue;
        }
        const { object } = await this.tab.cdp<{ object: { objectId: string } }>("page", "DOM.resolveNode", {
          backendNodeId: node.backendDOMNodeId,
        });
        const { result } = await this.tab.cdp<{ result: { value?: unknown } }>("page", "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function () { return this instanceof Element ? window.${H}.mark(this) : null }`,
          returnByValue: true,
        });
        if (typeof result.value === "string" && !marked.includes(result.value)) marked.push(result.value);
      }
    }
    return marked;
  }
}

export class LocatorImpl implements Locator {
  constructor(
    readonly page: PageImpl,
    readonly steps: Step[],
  ) {}

  #with(step: Step): LocatorImpl {
    return new LocatorImpl(this.page, [...this.steps, step]);
  }

  locator(selector: string): Locator {
    return this.#with(parseSelector(selector));
  }
  getByRole(role: string, options: RoleOptions = {}): Locator {
    return this.#with({ kind: "role", role, ...options });
  }
  getByText(text: string, { exact = false }: TextOptions = {}): Locator {
    return this.#with({ kind: "text", text, exact });
  }
  getByLabel(text: string, { exact = false }: TextOptions = {}): Locator {
    return this.#with({ kind: "label", text, exact });
  }
  getByPlaceholder(text: string, { exact = false }: TextOptions = {}): Locator {
    return this.#with({ kind: "placeholder", text, exact });
  }
  getByTestId(testId: string): Locator {
    return this.#with({ kind: "css", selector: `[data-testid=${JSON.stringify(testId)}]` });
  }
  first(): Locator {
    return this.#with({ kind: "first" });
  }

  resolve(): Promise<string[]> {
    return this.page.resolve(this.steps);
  }

  click({ button = "left" }: { button?: "left" | "right" } = {}): Promise<void> {
    // Bun.WebView's click needs the element in the viewport. Its selector click waits for the element to be
    // actionable, but can't reach into a shadow root: there, it clicks the element's centre.
    return this.page.act(this, "click", async (ref) => {
      const center = await this.page.tab.evaluate<{ x: number; y: number; inShadow: boolean } | null>(`${H}.center(${js(ref)})`);
      if (!center) throw new Error("the element was removed");
      this.page.tab.assertCurrent("click");
      await this.page.tab.native("click", (view) =>
        center.inShadow ? view.click(center.x, center.y, { button }) : view.click(`[data-vt-ref="${ref}"]`, { button, timeout: 2_000 }),
      );
    });
  }

  hover(): Promise<void> {
    return this.page.act(this, "hover", async (ref) => {
      const center = await this.page.tab.evaluate<{ x: number; y: number } | null>(`${H}.center(${js(ref)})`);
      if (!center) throw new Error("the element was removed");
      await this.page.tab.cdp("page", "Input.dispatchMouseEvent", { type: "mouseMoved", ...center });
    });
  }

  fill(text: string): Promise<void> {
    return this.page.act(this, "fill", async (ref) => {
      await this.page.tab.evaluate(`${H}.select(${js(ref)})`);
      this.page.tab.assertCurrent("fill");
      // Typing replaces the selected text (typing "" clears it).
      await this.page.tab.native("fill", (view) => view.type(text));
    });
  }

  async remove(): Promise<void> {
    await this.page.waitUntil(`${this} to be attached, to remove it`, async () => (await this.resolve()).length > 0);
    for (const ref of await this.resolve()) await this.page.tab.evaluate(`${H}.remove(${js(ref)})`);
  }

  async count(): Promise<number> {
    return (await this.resolve()).length;
  }

  async isVisible(): Promise<boolean> {
    for (const ref of await this.resolve()) {
      if (await this.page.tab.evaluate<boolean>(`${H}.visible(${js(ref)})`)) return true;
    }
    return false;
  }

  /** The first match's state, for the value assertions. */
  async state(): Promise<{ disabled: boolean; value: string | null; attributes: Record<string, string> } | null> {
    const [ref] = await this.resolve();
    return ref === undefined ? null : this.page.tab.evaluate(`${H}.state(${js(ref)})`);
  }

  toString(): string {
    const describe = (step: Step): string => {
      switch (step.kind) {
        case "css":
          return step.textIs === undefined ? `locator(${js(step.selector)})` : `locator(${js(`${step.selector}:text-is("${step.textIs}")`)})`;
        case "text":
          return `getByText(${js(step.text)})`;
        case "placeholder":
          return `getByPlaceholder(${js(step.text)})`;
        case "label":
          return `getByLabel(${js(step.text)})`;
        case "parent":
          return `locator("..")`;
        case "first":
          return "first()";
        case "role": {
          const { kind: _kind, role, ...options } = step;
          const name = options.name instanceof RegExp ? String(options.name) : options.name;
          const shown = Object.keys(options).length ? `, ${js({ ...options, name })}` : "";
          return `getByRole(${js(role)}${shown})`;
        }
      }
    };
    return this.steps.map(describe).join(".");
  }
}
