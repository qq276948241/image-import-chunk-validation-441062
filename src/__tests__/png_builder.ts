import { zlibSync } from 'fflate';

import { ColorType, InterlaceMethod } from '../internal_types.ts';

// https://www.w3.org/TR/PNG/#5PNG-file-signature
export const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

/**
 * A chunk represented by its four-letter type and raw data field.
 */
export interface PngChunk {
  /** Four ASCII-letter chunk type. */
  type: string;
  /** Raw chunk data without length, type or CRC. */
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[n] = c;
  }
  return table;
})();

/**
 * Compute the PNG CRC-32 checksum of a byte sequence.
 * @param data - Bytes to checksum.
 * @returns The unsigned 32-bit CRC value.
 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Serialize one chunk (length, type, data, CRC). The CRC is computed
 * independently of the production encoder so that tests do not prove
 * correctness through an encoder/decoder round trip.
 * @param chunk - Chunk type and data to serialize.
 * @returns The serialized chunk bytes.
 */
export function writeChunk(chunk: PngChunk): Uint8Array {
  const typeBytes = new TextEncoder().encode(chunk.type);
  const body = new Uint8Array(typeBytes.length + chunk.data.length);
  body.set(typeBytes, 0);
  body.set(chunk.data, typeBytes.length);
  const result = new Uint8Array(12 + chunk.data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, chunk.data.length);
  result.set(body, 4);
  view.setUint32(8 + chunk.data.length, crc32(body));
  return result;
}

/**
 * Serialize a chunk while deliberately writing a wrong CRC value. Used to
 * verify that CRC checking is independent of the structural checks.
 * @param chunk - Chunk type and data to serialize.
 * @returns The serialized chunk bytes with an invalid CRC.
 */
export function writeChunkWithBadCrc(chunk: PngChunk): Uint8Array {
  const result = writeChunk(chunk);
  const view = new DataView(result.buffer);
  const crcOffset = result.length - 4;
  view.setUint32(crcOffset, (view.getUint32(crcOffset) + 1) >>> 0);
  return result;
}

/**
 * Concatenate the signature and serialized chunks into a PNG file.
 * @param chunks - Serialized chunks in file order.
 * @returns The complete PNG byte array.
 */
export function assemblePng(chunks: Uint8Array[]): Uint8Array {
  let total = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const result = new Uint8Array(total);
  result.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Parse a PNG into its raw chunks. This is test-only infrastructure and does
 * not depend on the decoder under test.
 * @param png - Complete PNG byte array.
 * @returns The ordered list of chunks with their raw data.
 */
export function parseChunks(png: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  const decoder = new TextDecoder('ascii');
  while (offset < png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const type = decoder.decode(png.subarray(offset + 4, offset + 8));
    const data = png.slice(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

/**
 * Fields used to build an IHDR chunk in tests.
 */
export interface IHDRParams {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Bit depth, defaults to 8. */
  depth?: number;
  /** PNG color type, defaults to truecolour with alpha. */
  colorType?: number;
  /** Interlace method, defaults to no interlacing. */
  interlace?: number;
}

/**
 * Build a valid IHDR chunk from the given image parameters.
 * @param params - IHDR fields.
 * @returns The serialized IHDR chunk.
 */
export function makeIHDR(params: IHDRParams): Uint8Array {
  const {
    width,
    height,
    depth = 8,
    colorType = ColorType.TRUECOLOUR_ALPHA,
    interlace = InterlaceMethod.NO_INTERLACE,
  } = params;
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = depth;
  data[9] = colorType;
  data[10] = 0; // compression: deflate
  data[11] = 0; // filter: adaptive
  data[12] = interlace;
  return writeChunk({ type: 'IHDR', data });
}

/**
 * Build a zero-length IEND chunk.
 * @returns The serialized IEND chunk.
 */
export function makeIEND(): Uint8Array {
  return writeChunk({ type: 'IEND', data: new Uint8Array(0) });
}

/**
 * Build the raw, pre-filtering scanline data for an RGBA 8-bit image: every
 * scanline starts with filter type 0.
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @param fill - Byte value used for every sample, defaults to 0.
 * @returns The uncompressed scanline data.
 */
export function makeRawRgba(
  width: number,
  height: number,
  fill = 0,
): Uint8Array {
  const bytesPerLine = width * 4;
  const raw = new Uint8Array(height * (bytesPerLine + 1));
  for (let row = 0; row < height; row++) {
    const lineStart = row * (bytesPerLine + 1);
    raw[lineStart] = 0;
    for (let i = 0; i < bytesPerLine; i++) {
      raw[lineStart + 1 + i] = fill;
    }
  }
  return raw;
}

/**
 * Compress raw scanline data into an IDAT chunk.
 * @param raw - Uncompressed scanline data.
 * @returns The serialized IDAT chunk.
 */
export function makeIDAT(raw: Uint8Array): Uint8Array {
  return writeChunk({ type: 'IDAT', data: zlibSync(raw) });
}

/**
 * Truncate a serialized byte array at the given length.
 * @param bytes - Bytes to truncate.
 * @param length - Number of leading bytes to keep.
 * @returns The truncated byte array.
 */
export function truncate(bytes: Uint8Array, length: number): Uint8Array {
  return bytes.subarray(0, length);
}
