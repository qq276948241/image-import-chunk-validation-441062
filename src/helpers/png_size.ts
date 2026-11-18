import { checkedAdd, checkedMultiply } from './safe_math.ts';

/**
 * Geometry of a PNG image, shared by the size-computation helpers.
 */
export interface PngDimensions {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Number of channels per pixel (1 to 4). */
  channels: number;
  /** Bit depth of each sample. */
  depth: number;
  /** One of the INTERLACE_* constants. */
  interlaceMethod: number;
}

const ADAM7_PASSES = [
  { x: 0, y: 0, xStep: 8, yStep: 8 }, // Pass 1
  { x: 4, y: 0, xStep: 8, yStep: 8 }, // Pass 2
  { x: 0, y: 4, xStep: 4, yStep: 8 }, // Pass 3
  { x: 2, y: 0, xStep: 4, yStep: 4 }, // Pass 4
  { x: 0, y: 2, xStep: 2, yStep: 4 }, // Pass 5
  { x: 1, y: 0, xStep: 2, yStep: 2 }, // Pass 6
  { x: 0, y: 1, xStep: 1, yStep: 2 }, // Pass 7
];

/** No interlacing: the image is stored as a single sequence of scanlines. */
export const INTERLACE_NULL = 0;
/** Adam7 interlacing: the image is split into seven reduced passes. */
export const INTERLACE_ADAM7 = 1;

/**
 * Number of raw (uncompressed, pre-filtering) bytes in one scanline.
 * https://www.w3.org/TR/PNG/#7Scan-line-basics
 * @param width - Scanline width in pixels.
 * @param channels - Number of channels per pixel.
 * @param depth - Bit depth of each sample.
 * @returns The number of bytes used by one scanline.
 */
export function bytesPerScanline(
  width: number,
  channels: number,
  depth: number,
): number {
  // ceil(width * channels * depth / 8), computed with checked arithmetic.
  const bits = checkedMultiply(checkedMultiply(width, channels), depth);
  return Math.ceil(bits / 8);
}

/**
 * Raw size of one interlacing pass, including the per-scanline filter byte.
 * @param passWidth - Width of the pass in pixels.
 * @param passHeight - Height of the pass in pixels.
 * @param channels - Number of channels per pixel.
 * @param depth - Bit depth of each sample.
 * @returns The number of bytes the pass occupies in the zlib stream.
 */
function passSize(
  passWidth: number,
  passHeight: number,
  channels: number,
  depth: number,
): number {
  if (passWidth <= 0 || passHeight <= 0) {
    return 0;
  }
  const lineBytes = bytesPerScanline(passWidth, channels, depth);
  // Every scanline is prefixed with one filter-type byte.
  return checkedMultiply(passHeight, checkedAdd(lineBytes, 1));
}

/**
 * Total number of bytes the zlib stream must decompress to for the given
 * image layout. The decoder rejects streams that are shorter or longer.
 * @param params - Image geometry.
 * @returns The exact expected decompressed length in bytes.
 */
export function expectedRawDataSize(params: PngDimensions): number {
  const { width, height, channels, depth, interlaceMethod } = params;
  if (interlaceMethod === INTERLACE_NULL) {
    return passSize(width, height, channels, depth);
  }
  if (interlaceMethod === INTERLACE_ADAM7) {
    let total = 0;
    for (const pass of ADAM7_PASSES) {
      const passWidth = Math.ceil((width - pass.x) / pass.xStep);
      const passHeight = Math.ceil((height - pass.y) / pass.yStep);
      total = checkedAdd(
        total,
        passSize(passWidth, passHeight, channels, depth),
      );
    }
    return total;
  }
  // Unknown interlace methods are reported separately during decoding.
  return 0;
}

/**
 * Number of bytes in the final pixel output. For sub-byte depths (1, 2 and 4)
 * the samples remain packed, most-significant-bit first, exactly as stored in
 * the PNG scanlines; depth 16 uses two bytes per sample.
 * @param params - Image geometry.
 * @returns The output buffer size in bytes.
 */
export function expectedOutputSize(params: PngDimensions): number {
  const { width, height, channels, depth } = params;
  return checkedMultiply(height, bytesPerScanline(width, channels, depth));
}
