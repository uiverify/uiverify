import { test } from "vitest";
import { takeSnapshot } from "@uiverify/vitest";

/** Resolves once `img` has loaded or failed to. */
function settled(img: HTMLImageElement): Promise<unknown> {
  return new Promise((resolve) => {
    img.addEventListener("load", resolve);
    img.addEventListener("error", resolve);
  });
}

async function showImage(src: string): Promise<void> {
  const img = document.createElement("img");
  img.src = src;
  document.body.replaceChildren(img);
  await settled(img);
}

test("image whose bytes change on every request", async () => {
  await showImage(`${__ASSETS__}/changing.png`);
});

test("the changing image again, in a later test", async () => {
  await showImage(`${__ASSETS__}/changing.png`);
});

async function addSheet(href: string): Promise<void> {
  document.head.querySelectorAll("link[data-changing]").forEach((link) => link.remove());
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.changing = "";
  const ready = new Promise((resolve) => {
    link.addEventListener("load", resolve);
    link.addEventListener("error", resolve);
  });
  document.head.append(link);
  await ready;
  document.body.innerHTML = "<p>styled</p>";
}

test("stylesheet whose content changes on every request", async () => {
  await addSheet(`${__ASSETS__}/changing.css`);
});

test("the changing stylesheet again, in a later test", async () => {
  await addSheet(`${__ASSETS__}/changing.css`);
});

test("image behind a redirect to a changing one", async () => {
  await showImage(`${__ASSETS__}/redirect.png`);
});

test("image served only once", async () => {
  await showImage(`${__ASSETS__}/once.png`);
});

// The test returns while the data is still on its way: only the capture's wait for the network gets the
// image into the snapshot.
test("image from data fetched after render", () => {
  document.body.innerHTML = "<p>loading</p>";
  void fetch(`${__ASSETS__}/slow-data`)
    .then((response) => response.json())
    .then((data: { src: string }) => {
      document.body.innerHTML = `<img src="${data.src}">`;
    });
});

test("takeSnapshot() right after a fetch starts", async () => {
  document.body.innerHTML = "<p>loading</p>";
  void fetch(`${__ASSETS__}/slower-data`)
    .then((response) => response.json())
    .then((data: { src: string }) => {
      document.body.innerHTML = `<img src="${data.src}" alt="manual">`;
    });
  await takeSnapshot("after fetch");
});

test("a short test that snapshots while a request never finishes", { timeout: 5_000 }, async () => {
  document.body.innerHTML = "<p>short</p>";
  void fetch(`${__ASSETS__}/never-short`).catch(() => undefined);
  await takeSnapshot("short");
});

test("request that never finishes", () => {
  document.body.innerHTML = "<p>streaming</p>";
  void fetch(`${__ASSETS__}/never`).catch(() => undefined);
});

test("after a request that never finishes", () => {
  document.body.innerHTML = "<p>next</p>";
});

test("a new request to a URL that never finished before", () => {
  document.body.innerHTML = "<p>again</p>";
  void fetch(`${__ASSETS__}/never`).catch(() => undefined);
});
