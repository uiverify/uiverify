/** Resolves once `el` has loaded or failed to. */
export async function loaded(el: HTMLImageElement | HTMLLinkElement): Promise<void> {
  await new Promise((resolve) => {
    el.addEventListener("load", resolve);
    el.addEventListener("error", resolve);
  });
}
