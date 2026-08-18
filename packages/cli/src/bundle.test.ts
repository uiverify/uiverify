import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeArchiveIfNeeded, finalizeScreenshots, onlyChangedNoOpReason, readArchiveProducer } from "./bundle";

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

  it("lifts the capture-SDK producer from the snapshots into the manifest", () => {
    const producer = { name: "@uiverify/playwright", version: "1.2.3" };
    writeSnapshot("a.json", { id: "a", title: "t", name: "", dom: {}, resources: {}, producer });
    writeSnapshot("b.json", { id: "b", title: "t", name: "", dom: {}, resources: {}, producer });

    finalizeArchiveIfNeeded(dir);

    expect(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")).producer).toEqual(producer);
  });

  it("omits producer when the snapshots carry none (a pre-stamp SDK)", () => {
    writeSnapshot("a.json", { id: "a", title: "t", name: "", dom: {}, resources: {} });
    finalizeArchiveIfNeeded(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"))).not.toHaveProperty("producer");
  });
});

describe("readArchiveProducer", () => {
  it("reads the producer the finalize step stamped into index.json", () => {
    const producer = { name: "@uiverify/vitest", version: "0.9.0" };
    writeSnapshot("a.json", { id: "a", title: "t", name: "", dom: {}, resources: {}, producer });
    finalizeArchiveIfNeeded(dir);
    expect(readArchiveProducer(dir)).toEqual(producer);
  });

  it("returns null for a Storybook bundle (index.json with no producer) and a missing/garbage index", () => {
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ v: 1, entries: {} }));
    expect(readArchiveProducer(dir)).toBeNull();
    fs.rmSync(path.join(dir, "index.json"));
    expect(readArchiveProducer(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "index.json"), "not json{");
    expect(readArchiveProducer(dir)).toBeNull();
  });
});

describe("onlyChangedNoOpReason", () => {
  /** A Storybook static build: the preview frame plus its manifest. */
  function storybookDir(): void {
    fs.writeFileSync(path.join(dir, "iframe.html"), "<html></html>");
    fs.writeFileSync(path.join(dir, "index.json"), "{}");
  }

  it("names the missing graph for a Storybook dir built without --stats-json", () => {
    storybookDir();
    expect(onlyChangedNoOpReason(dir)).toBe("no-graph");
  });

  it("stays quiet once preview-stats.json is there", () => {
    storybookDir();
    fs.writeFileSync(path.join(dir, "preview-stats.json"), "{}");
    expect(onlyChangedNoOpReason(dir)).toBeNull();
  });

  // The server forces skip off for archives, so the flag is a guaranteed no-op — and it's provable
  // here, which is the whole point: never let the user pay for a full render believing otherwise.
  it("names the archive case, which can never have a graph", () => {
    writeSnapshot("login-abc123.json", { id: "a", title: "a", name: "" });
    expect(onlyChangedNoOpReason(dir)).toBe("archive");
  });

  // `createBundle` writes index.json into the user's archive dir, so a retried CI step or any local
  // re-run sees a *finalized* archive — it must not start reading as Storybook.
  it("still reads a CLI-finalized archive as an archive, not as Storybook", () => {
    writeSnapshot("login-abc123.json", { id: "a", title: "a", name: "" });
    finalizeArchiveIfNeeded(dir);
    expect(fs.existsSync(path.join(dir, "index.json"))).toBe(true);
    expect(onlyChangedNoOpReason(dir)).toBe("archive");
  });

  // A Storybook build can copy a `snapshots/` asset dir into its output; that must not read as an
  // archive and produce archive advice for a bundle that just needs --stats-json.
  it("still says no-graph for a Storybook dir that contains a snapshots/ asset folder", () => {
    storybookDir();
    writeSnapshot("some-asset.json", { id: "a", title: "a", name: "" });
    expect(onlyChangedNoOpReason(dir)).toBe("no-graph");
  });

  // A missing dir already fails loudly a moment later; this hint would only misdirect.
  it("stays quiet when the static dir doesn't exist", () => {
    expect(onlyChangedNoOpReason(path.join(dir, "nope"))).toBeNull();
  });
});

describe("finalizeScreenshots", () => {
  function writeImage(rel: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "not-a-real-png-but-finalize-only-reads-names");
  }

  it("assembles a manifest keyed by the POSIX path with the extension dropped", () => {
    writeImage(path.join("checkout", "mobile", "cart.png"));
    writeImage("home.png");
    writeImage(path.join("nested", "deep", "profile.jpeg"));

    finalizeScreenshots(dir);

    const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    expect(index.v).toBe(1);
    expect(index.entries["checkout/mobile/cart"]).toEqual({
      id: "checkout/mobile/cart",
      type: "story",
      title: "checkout/mobile",
      name: "cart",
      image: "checkout/mobile/cart.png",
    });
    // A top-level image has no group title.
    expect(index.entries["home"]).toEqual({ id: "home", type: "story", title: "", name: "home", image: "home.png" });
    // jpeg is accepted too.
    expect(index.entries["nested/deep/profile"]?.image).toBe("nested/deep/profile.jpeg");
  });

  it("throws when the directory has no images", () => {
    fs.writeFileSync(path.join(dir, "readme.txt"), "x");
    expect(() => finalizeScreenshots(dir)).toThrow(/no screenshots/);
  });

  it("throws when two images reduce to the same id", () => {
    writeImage("cart.png");
    writeImage("cart.jpg");
    expect(() => finalizeScreenshots(dir)).toThrow(/same id "cart"/);
  });
})
