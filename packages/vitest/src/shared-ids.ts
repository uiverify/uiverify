/** Which browser project wrote each snapshot id into each archive dir, per run. */
const writersByRun = new WeakMap<object, Map<string, string>>();
const warnedRuns = new WeakSet<object>();

/** A one-time warning when a second browser project writes a snapshot id another already wrote this run
 *  into the same archive dir (one suite run under several projects or `browser.instances`, or projects with
 *  their own roots whose test files share a path): the ids carry no project, so each write replaces the
 *  other's file. A retry rewrites its own project's id and is not reported. */
export function sharedIdWarning(run: object, outDir: string, projectName: string, id: string): string | undefined {
  let writers = writersByRun.get(run);
  if (!writers) writersByRun.set(run, (writers = new Map()));
  const key = `${outDir}\n${id}`;
  const earlier = writers.get(key);
  writers.set(key, projectName);
  if (earlier === undefined || earlier === projectName || warnedRuns.has(run)) return undefined;
  warnedRuns.add(run);
  return (
    `[uiverify] "${id}" was captured by both the "${earlier}" and "${projectName}" browser projects into one ` +
    "archive folder, so only one capture is kept. Give each project its own uiverifyPlugin({ outDir }), or " +
    "run each visual test in only one browser project."
  );
}
