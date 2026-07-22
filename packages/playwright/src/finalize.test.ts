import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeArchive } from "./finalize";
import { snapshotFileName } from "./archiver";
import type { ArchiveIndex, ArchivedSnapshot } from "./archive-types";

/** Read + parse the manifest the way the server's consumer does (kept local — the client never
 *  imports any private code). */
function readIndex(bundle: string): ArchiveIndex {
  return JSON.parse(fs.readFileSync(path.join(bundle, "index.json"), "utf8"));
}

/** Write a minimal snapshot file into a bundle's snapshots/ dir, the way the archiver does. */
function writeSnapshot(bundle: string, snap: Pick<ArchivedSnapshot, "id" | "title" | "name">): void {
  const dir = path.join(bundle, "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const full: ArchivedSnapshot = {
    ...snap,
    viewport: { width: 800, height: 600 },
    dom: { type: 0, childNodes: [], id: 1 } as unknown as ArchivedSnapshot["dom"],
    resources: {},
  };
  fs.writeFileSync(path.join(dir, snapshotFileName(snap.id)), JSON.stringify(full));
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

describe("finalizeArchive", () => {
  it("builds a v1 manifest the archive-replay capturer accepts", () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-finalize-"));
    try {
      writeSnapshot(bundle, { id: "home", title: "home page", name: "" });
      writeSnapshot(bundle, { id: "home::after", title: "home page", name: "after" });

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
