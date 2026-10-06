import { onTestFinished, test } from "vitest";

/** Make the automatic capture throw for this test: it reads `document.fonts` while settling. */
function breakCapture(): void {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    get() {
      throw new Error("capture broke");
    },
  });
  onTestFinished(() => {
    Reflect.deleteProperty(document, "fonts");
  });
}

test("capture fails on a passing test", () => {
  breakCapture();
  document.body.innerHTML = "<p>passing</p>";
});

test("capture fails on a failing test", () => {
  breakCapture();
  throw new Error("the test's own failure");
});
