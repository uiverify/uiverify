import { test } from "@uiverify/playwright";

/** Every screen archived at a desktop and a mobile viewport, so a layout regression at either width is
 *  caught (mobile is a first-class baseline, not an afterthought). */
const SCREENS: { name: string; path: string }[] = [
  { name: "storefront", path: "/" },
  { name: "product", path: "/product/sunrise-mug" },
  { name: "sign-in", path: "/login" },
  { name: "cart-empty", path: "/cart" },
  { name: "order-confirmed", path: "/success" },
];

for (const { name, path } of SCREENS) {
  test(name, async ({ page, uiVerify }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    await uiVerify.snapshot("desktop");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.fonts.ready);
    await uiVerify.snapshot("mobile");
  });
}
