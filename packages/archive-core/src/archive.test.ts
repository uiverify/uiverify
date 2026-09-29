import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeArchive } from "./finalize";
import { snapshotFileName } from "./snapshot-file";
import { writeSnapshot } from "./write";
import type { ArchiveIndex, ArchivedSnapshot, CapturedResource, CapturedSnapshot } from "./archive-types";

/** Read + parse the manifest the way the server's consumer does (kept local — the client never
 *  imports any private code). */
function readIndex(bundle: string): ArchiveIndex {
  return JSON.parse(fs.readFileSync(path.join(bundle, "index.json"), "utf8"));
}

/** Write a minimal snapshot into a bundle through the real writer (so the test exercises writeSnapshot,
 *  not a hand-rolled copy of it). */
function seedSnapshot(bundle: string, snap: Pick<ArchivedSnapshot, "id" | "title" | "name">): void {
  writeSnapshot(bundle, {
    ...snap,
    viewport: { width: 800, height: 600 },
    dom: { type: 0, childNodes: [], id: 1 } as unknown as ArchivedSnapshot["dom"],
    resources: {},
  });
}

describe("snapshotFileName", () => {
  it("is deterministic and filesystem-safe", () => {
    const id = "login.spec.ts > logs in > after submit";
    expect(snapshotFileName(id)).toBe(snapshotFileName(id));
    expect(snapshotFileName(id)).toMatch(/^[a-zA-Z0-9._-]+\.json$/);
  });

  it("disambiguates ids that slugify the same", () => {
    // Same slug (only punctuation differs), but the hash of the full id keeps them distinct.
    expect(snapshotFileName("a/b")).not.toBe(snapshotFileName("a:b"));
  });

  it("never emits an empty basename", () => {
    expect(snapshotFileName("///")).toMatch(/^snapshot-[0-9a-f]{10}\.json$/);
  });
});

describe("writeSnapshot", () => {
  it("writes the snapshot under snapshots/ at its deterministic filename", () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-write-"));
    try {
      const written = writeSnapshot(bundle, {
        id: "home",
        title: "home page",
        name: "",
        viewport: { width: 800, height: 600 },
        dom: { type: 0, childNodes: [], id: 1 } as unknown as ArchivedSnapshot["dom"],
        resources: {},
      });
      expect(written).toBe(path.join(bundle, "snapshots", snapshotFileName("home")));
      expect(fs.existsSync(written)).toBe(true);
      expect(JSON.parse(fs.readFileSync(written, "utf8")).id).toBe("home");
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe("writeSnapshot resource store", () => {
  const png = (bytes: number[]): CapturedResource => ({
    contentType: "image/png",
    status: 200,
    body: Buffer.from(bytes).toString("base64"),
  });

  /** Catches a writer that inlines bytes per snapshot again: a logo on every page must be stored once,
   *  and each snapshot must point at that one file rather than carry its own copy. */
  it("stores identical resource bytes once and points every snapshot at the same file", () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-resources-"));
    try {
      const write = (id: string, resources: Record<string, CapturedResource>) =>
        JSON.parse(
          fs.readFileSync(
            writeSnapshot(bundle, {
              id,
              title: id,
              name: "",
              viewport: { width: 800, height: 600 },
              dom: { type: 0, childNodes: [], id: 1 } as unknown as ArchivedSnapshot["dom"],
              resources,
            }),
            "utf8",
          ),
        ) as ArchivedSnapshot;

      const a = write("a", { "http://x/logo.png": png([1, 2, 3]), "http://x/a.png": png([4]) });
      const b = write("b", { "http://x/logo.png": png([1, 2, 3]), "http://x/b.png": png([5]) });

      expect(a.resources["http://x/logo.png"]?.file).toBe(b.resources["http://x/logo.png"]?.file);
      expect(a.resources["http://x/a.png"]?.file).not.toBe(b.resources["http://x/b.png"]?.file);
      expect(fs.readdirSync(path.join(bundle, "resources")).sort()).toHaveLength(3);
      const logo = a.resources["http://x/logo.png"];
      expect(logo).toEqual({ contentType: "image/png", status: 200, file: expect.stringMatching(/^resources\/[0-9a-f]{64}$/) });
      expect([...fs.readFileSync(path.join(bundle, logo?.file ?? ""))]).toEqual([1, 2, 3]);
      expect(JSON.stringify(a)).not.toContain('"body"');
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe("writeSnapshot baselineImage", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const withDesign = (id: string): CapturedSnapshot => ({
    id,
    title: "home page",
    name: "",
    viewport: { width: 800, height: 600 },
    dom: { type: 0, childNodes: [], id: 1 } as unknown as ArchivedSnapshot["dom"],
    resources: {},
    baselineImage: `data:image/png;base64,${PNG.toString("base64")}`,
  });

  // The manifest must carry a short bundle path (not megabytes of base64), and the file must ship in the
  // bundle under a name that is its content hash, which is what lets UI Verify skip an unchanged design.
  it("moves a data-URI design to design/<sha256>.png and lifts that path into the manifest", () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-design-"));
    try {
      writeSnapshot(bundle, withDesign("home"));
      writeSnapshot(bundle, withDesign("home::after"));
      finalizeArchive(bundle);

      const rel = `design/${createHash("sha256").update(PNG).digest("hex")}.png`;
      expect(fs.readFileSync(path.join(bundle, rel)).equals(PNG)).toBe(true);
      expect(fs.readdirSync(path.join(bundle, "design"))).toHaveLength(1);
      const index = readIndex(bundle);
      expect(index.entries["home"].baselineImage).toBe(rel);
      expect(index.entries["home::after"].baselineImage).toBe(rel);
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe("finalizeArchive", () => {
  it("builds a v1 manifest the archive-replay capturer accepts", () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-finalize-"));
    try {
      seedSnapshot(bundle, { id: "home", title: "home page", name: "" });
      seedSnapshot(bundle, { id: "home::after", title: "home page", name: "after" });

      const count = finalizeArchive(bundle);
      expect(count).toBe(2);

      // The produced manifest is a valid v1 archive index (what the server consumes).
      const index = readIndex(bundle);
      expect(index.v).toBe(1);
      expect(new Set(Object.keys(index.entries))).toEqual(new Set(["home", "home::after"]));
      const entry = index.entries["home::after"];
      expect(entry.type).toBe("story");
      expect(entry.name).toBe("after");
      // The recorded path resolves to a real snapshot file inside the bundle.
      expect(fs.existsSync(path.join(bundle, entry.snapshot))).toBe(true);
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });

  it("writes an empty manifest when nothing was captured", () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-finalize-empty-"));
    try {
      expect(finalizeArchive(bundle)).toBe(0);
      expect(readIndex(bundle).entries).toEqual({});
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });
});
