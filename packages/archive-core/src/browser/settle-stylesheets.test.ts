import { afterEach, expect, it, vi } from "vitest";
import { settle } from "./settle";

vi.mock("./real-timers", () => ({
  sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
}));

/** A stylesheet link that never answers: no sheet, and it counts the listeners settle attaches. */
class NeverLink {
  sheet = null;
  attached = 0;
  shadowRoot = undefined;
  relList = { contains: (token: string) => token === "stylesheet" };
  type = "";
  disabled = false;
  constructor(public href: string) {}
  getAttribute() {
    return this.href;
  }
  addEventListener() {
    this.attached++;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Catches every snapshot of a page waiting out the time box on a stylesheet that never answers: the cap
 *  is the same one an author sees as a stalled capture, so it is paid once per document. The memo is what
 *  the Bun and Playwright e2e timing tests check end to end. */
it("gives up on a stylesheet that never answers once, so a later settle doesn't wait on it again", async () => {
  const link = new NeverLink("https://fonts.test/never.css");
  vi.stubGlobal("HTMLLinkElement", NeverLink);
  vi.stubGlobal("HTMLStyleElement", class {});
  vi.stubGlobal("Image", class {});
  vi.stubGlobal("HTMLImageElement", class {});
  vi.stubGlobal("document", {
    querySelectorAll: () => [link],
    fonts: Object.assign([], { ready: Promise.resolve() }),
    documentElement: { getBoundingClientRect: () => undefined },
  });
  vi.stubGlobal("getComputedStyle", () => ({ backgroundImage: "none" }));

  await settle({ fonts: "used" });
  expect(link.attached).toBe(2);

  await settle({ fonts: "used" });
  expect(link.attached).toBe(2);
});

/** Catches the give-up memo outliving the sheet it was made for: a theme link that timed out once and is
 *  then pointed at another stylesheet starts a new load, whose fonts the next snapshot has to wait for. */
it("waits again on a given-up link once its href is rewritten", async () => {
  const link = new NeverLink("https://fonts.test/light.css");
  vi.stubGlobal("HTMLLinkElement", NeverLink);
  vi.stubGlobal("HTMLStyleElement", class {});
  vi.stubGlobal("Image", class {});
  vi.stubGlobal("HTMLImageElement", class {});
  vi.stubGlobal("document", {
    querySelectorAll: () => [link],
    fonts: Object.assign([], { ready: Promise.resolve() }),
    documentElement: { getBoundingClientRect: () => undefined },
  });
  vi.stubGlobal("getComputedStyle", () => ({ backgroundImage: "none" }));

  await settle({ fonts: "used" });
  expect(link.attached).toBe(2);

  link.href = "https://fonts.test/dark.css";
  await settle({ fonts: "used" });
  expect(link.attached).toBe(4);
});
