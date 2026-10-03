/** The in-browser API (`commands`) the capture code imports. Vitest 4 added this name and Vitest 5 removed
 *  the old one, but Vitest 3 only has the old one, so there the import is pointed at it instead. */
const BROWSER_API = "vitest/browser";
const LEGACY_BROWSER_API = "@vitest/browser/context";

type ResolveFn = (id: string) => Promise<{ id: string } | null>;

/** Resolve {@link BROWSER_API}, falling back to {@link LEGACY_BROWSER_API} when the running Vitest has no
 *  such export (Vite rejects a missing package export rather than returning null, hence the catch). */
export async function resolveBrowserApi(id: string, resolve: ResolveFn): Promise<{ id: string } | null> {
  if (id !== BROWSER_API) return null;
  const current = await resolve(BROWSER_API).catch(() => null);
  return current ?? resolve(LEGACY_BROWSER_API);
}
