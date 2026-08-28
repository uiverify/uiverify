export type Product = {
  id: string;
  name: string;
  price: number;
  art: string;
  blurb: string;
};

/** A tiny fixed catalog. No photos — each product is a solid-color "art" block — so every screenshot
 *  renders pixel-identically on any device (an honest visual baseline). */
export const PRODUCTS: Product[] = [
  { id: "sunrise-mug", name: "Sunrise Mug", price: 24, art: "#E8A87C", blurb: "Stoneware, 12oz" },
  { id: "halo-headphones", name: "Halo Headphones", price: 129, art: "#7C9EE8", blurb: "Wireless, 30h battery" },
  { id: "fern-tote", name: "Fern Tote", price: 38, art: "#8CB88C", blurb: "Organic canvas" },
  { id: "pocket-speaker", name: "Pocket Speaker", price: 59, art: "#C98CB8", blurb: "Bluetooth, IPX7" },
];

export const getProduct = (id: string): Product | undefined => PRODUCTS.find((p) => p.id === id);
