import type { KeyRead, KeyStore, KeyStoreId } from "./credentials";

/** An in-memory key store for tests. `keychain` behaves like macOS (one fixed key, no refs); the others give
 *  every created key its own ref, like the Linux and Windows stores. */
export interface FakeKeyStore extends KeyStore {
  /** The keys it holds, by ref (`""` for the fixed macOS key). Delete one to make it "absent". */
  held: Map<string, Buffer>;
  /** Every read and create answers "can't answer" (a locked keychain, a sandboxed shell). */
  locked: boolean;
  /** Every read and create answers with a timeout (an unlock dialog nobody answered). */
  timedOut: boolean;
  creates: number;
}

export function fakeKeyStore(id: KeyStoreId = "secret-service"): FakeKeyStore {
  const fixed = id === "keychain";
  const blocked = (): KeyRead | null =>
    k.timedOut
      ? { kind: "unavailable", reason: "no answer", timedOut: true }
      : k.locked
        ? { kind: "unavailable", reason: "User interaction is not allowed." }
        : null;
  const k: FakeKeyStore = {
    id,
    name: "keyring",
    unlockHint: "Unlock it",
    held: new Map(),
    locked: false,
    timedOut: false,
    creates: 0,
    read(ref) {
      const no = blocked();
      if (no) return no;
      if (fixed !== (ref === undefined)) return { kind: "unrecognised" };
      const key = k.held.get(ref ?? "");
      return key ? (fixed ? { kind: "found", key } : { kind: "found", key, ref }) : { kind: "absent" };
    },
    create() {
      const no = blocked();
      if (no) return no;
      k.creates++;
      const ref = fixed ? "" : `ref-${k.creates}`;
      if (!k.held.has(ref)) k.held.set(ref, Buffer.alloc(32, k.creates));
      return k.read(fixed ? undefined : ref);
    },
  };
  return k;
}
