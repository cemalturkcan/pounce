import type { RgbaImage } from "../src/visual/pixels.ts";

export function pixel(image: RgbaImage, x: number, y: number) {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
}
