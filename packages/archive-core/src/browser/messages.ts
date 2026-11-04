/** What an SDK prints when the wait for a stable frame gave up on an animation that never finished. Imports
 *  nothing, so both the Node and the in-page entries export it. */
export function stillAnimatingWarning(sdk: string, id: string): string {
  return (
    `${sdk}: "${id}" was still animating (a requestAnimationFrame loop) when the wait for a stable frame ran ` +
    "out, so it was captured mid-animation. Stop the animation while UI Verify captures: check isUIVerify()."
  );
}
