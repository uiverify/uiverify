import { test } from "vitest";

async function loaded(el: HTMLImageElement | HTMLLinkElement): Promise<void> {
  await new Promise((resolve) => {
    el.addEventListener("load", resolve);
    el.addEventListener("error", resolve);
  });
}

test("cross-origin image without CORS", async () => {
  const img = document.createElement("img");
  img.src = `${__ASSETS__}/icon.png`;
  document.body.replaceChildren(img);
  await loaded(img);
});

test("web font from a cross-origin link without crossorigin", async () => {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${__ASSETS__}/font.css`;
  document.head.append(link);
  await loaded(link);
  document.body.innerHTML = '<p style="font-family: Brand">text</p>';
  await document.fonts.load("16px Brand", "text");
});

test("image that errors at capture", async () => {
  const img = document.createElement("img");
  img.src = `${__ASSETS__}/gone.png`;
  document.body.replaceChildren(img);
  await loaded(img);
});

test("blob image", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 4;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  const img = document.createElement("img");
  img.src = blob ? URL.createObjectURL(blob) : "";
  document.body.replaceChildren(img);
  await loaded(img);
});

test("blob image revoked once it loaded", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 4;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  const img = document.createElement("img");
  img.src = blob ? URL.createObjectURL(blob) : "";
  document.body.replaceChildren(img);
  await loaded(img);
  URL.revokeObjectURL(img.src);
});
