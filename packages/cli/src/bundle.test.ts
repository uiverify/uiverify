import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeArchiveIfNeeded } from "./bundle";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vt-bundle-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeSnapshot(name: string, snap: Record<string, unknown>): void {
  const snapshotsDir = path.join(dir, "snapshots");
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotsDir, name), JSON.stringify(snap));
}

describe("finalizeArchiveIfNeeded", () => {
  it("assembles index.json from per-snapshot files, keeping only id/title/name + the relative path", () => {
    writeSnapshot("login-abc123.json", {
      id: "login.spec.ts::logs in",
      title: "login.spec.ts",
      name: "",
      dom: { some: "big payload" },
      resources: {},
    });
    writeSnapshot("cart-def456.json", {
      id: "cart.spec.ts::checkout::after submit",
      title: "cart.spec.ts::checkout",
      name: "after submit",
      dom: {},
      resources: {},
    });

    finalizeArchiveIfNeeded(dir);

    const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    expect(index.v).toBe(1);
    expect(index.entries["login.spec.ts::logs in"]).toEqual({
      id: "login.spec.ts::logs in",
      type: "story",
      title: "login.spec.ts",
      name: "",
      snapshot: path.join("snapshots", "login-abc123.json"),
    });
    expect(index.entries["cart.spec.ts::checkout::after submit"]).toMatchObject({
      type: "story",
      name: "after submit",
      snapshot: path.join("snapshots", "cart-def456.json"),
    });
    // The heavy dom/resources payload is dropped from the manifest.
    expect(index.entries["login.spec.ts::logs in"]).not.toHaveProperty("dom");
  });

  it("is a no-op when index.json already exists (a Storybook static dir)", () => {
    const existing = { v: 1, entries: { "existing--story": { id: "existing--story" } } };
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(existing));
    writeSnapshot("ignored-000.json", { id: "x", title: "x", name: "" });

    finalizeArchiveIfNeeded(dir);

    expect(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"))).toEqual(existing);
  });

  it("does nothing when there is no snapshots dir", () => {
    finalizeArchiveIfNeeded(dir);
    expect(fs.existsSync(path.join(dir, "index.json"))).toBe(false);
  });
});
