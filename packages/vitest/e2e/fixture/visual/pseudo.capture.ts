import { beforeEach, describe, onTestFinished, test } from "vitest";
import { userEvent } from "vitest/browser";

const BUTTON = '<button id="target" style="position:absolute;left:0;top:0;width:80px;height:40px">target</button>';

function byId(root: Document | ShadowRoot, id: string): HTMLElement {
  const el = root.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  return el;
}

test("hovered button", async () => {
  document.body.innerHTML = BUTTON;
  await userEvent.hover(byId(document, "target"));
});

test("focused input", () => {
  document.body.innerHTML = '<form><input id="field"></form>';
  byId(document, "field").focus();
});

test("hovered inside a shadow root", async () => {
  document.body.innerHTML = '<div id="host"></div>';
  const root = byId(document, "host").attachShadow({ mode: "open" });
  root.innerHTML = '<span id="inner" style="display:block;width:80px;height:40px">inner</span>';
  await userEvent.hover(byId(root, "inner"));
});

// Runs right after a test that left the pointer over this spot.
test("button where an earlier test left the pointer", () => {
  document.body.innerHTML = BUTTON;
});


describe("hovered in a beforeEach", () => {
  beforeEach(async () => {
    document.body.innerHTML = BUTTON;
    await userEvent.hover(byId(document, "target"));
  });

  test("keeps the hover", () => {});
});

test("hovered, then its capture fails", async () => {
  document.body.innerHTML = BUTTON;
  await userEvent.hover(byId(document, "target"));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    get() {
      throw new Error("capture broke");
    },
  });
  onTestFinished(() => {
    Reflect.deleteProperty(document, "fonts");
  });
});

// Runs right after a test whose capture threw with the pointer over this spot.
test("button after a failed capture", () => {
  document.body.innerHTML = BUTTON;
});

describe.concurrent("hovering concurrently", () => {
  test("hovers the button", async () => {
    document.body.innerHTML = BUTTON;
    await userEvent.hover(byId(document, "target"));
  });
});

// Runs right after a concurrent test that left the pointer over this spot.
test("button after a concurrent test", () => {
  document.body.innerHTML = BUTTON;
});
