import type { PngDataArray } from '../types.ts';

import { PngFormatError } from './error.ts';
import {
  INTERLACE_NULL,
  bytesPerScanline,
  expectedOutputSize,
  expectedRawDataSize,
} from './png_size.ts';
import { checkOutputBudget } from './safe_math.ts';
import {
  unfilterAverage,
  unfilterNone,
  unfilterPaeth,
  unfilterSub,
  unfilterUp,
} from './unfilter.ts';

const uint16 = new Uint16Array([0x00ff]);
const uint8 = new Uint8Array(uint16.buffer);
const osIsLittleEndian = uint8[0] === 0xff;

const empty = new Uint8Array(0);

export interface DecodeInterlaceNullParams {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
  depth: number;
  maxOutputSize?: number;
}

/**
 * Decode a non-interlaced PNG stream: validate the decompressed length and
 * output budget, then reverse the adaptive row filtering.
 * @param params - Image data, geometry and optional output limit.
 * @returns The restored pixel data.
 */
export function decodeInterlaceNull(
  params: DecodeInterlaceNullParams,
): PngDataArray {
  const {
    data,
    width,
    height,
    channels,
    depth,
    maxOutputSize = Number.POSITIVE_INFINITY,
  } = params;

  const bytesPerPixel = Math.ceil(depth / 8) * channels;

  const bytesPerLine = bytesPerScanline(width, channels, depth);
  const expectedLength = expectedRawDataSize({
    width,
    height,
    channels,
    depth,
    interlaceMethod: INTERLACE_NULL,
  });
  if (data.length !== expectedLength) {
    throw new PngFormatError(
      `Decompressed data length mismatch: expected ${expectedLength} bytes for ${width}x${height} image, got ${data.length}`,
    );
  }

  const outputSize = expectedOutputSize({
    width,
    height,
    channels,
    depth,
    interlaceMethod: INTERLACE_NULL,
  });
  checkOutputBudget(outputSize, maxOutputSize);

  const newData = new Uint8Array(outputSize);

  let prevLine = empty;
  let offset = 0;
  let currentLine;
  let newLine;

  for (let i = 0; i < height; i++) {
    currentLine = data.subarray(offset + 1, offset + 1 + bytesPerLine);
    newLine = newData.subarray(i * bytesPerLine, (i + 1) * bytesPerLine);
    switch (data[offset]) {
      case 0:
        unfilterNone(currentLine, newLine, bytesPerLine);
        break;
      case 1:
        unfilterSub(currentLine, newLine, bytesPerLine, bytesPerPixel);
        break;
      case 2:
        unfilterUp(currentLine, newLine, prevLine, bytesPerLine);
        break;
      case 3:
        unfilterAverage(
          currentLine,
          newLine,
          prevLine,
          bytesPerLine,
          bytesPerPixel,
        );
        break;
      case 4:
        unfilterPaeth(
          currentLine,
          newLine,
          prevLine,
          bytesPerLine,
          bytesPerPixel,
        );
        break;
      default:
        throw new PngFormatError(`Unsupported filter: ${data[offset]}`);
    }
    prevLine = newLine;
    offset += bytesPerLine + 1;
  }

  if (depth === 16) {
    const uint16Data = new Uint16Array(newData.buffer);
    if (osIsLittleEndian) {
      for (let k = 0; k < uint16Data.length; k++) {
        // PNG is always big endian. Swap the bytes.
        uint16Data[k] = swap16(uint16Data[k]);
      }
    }
    return uint16Data;
  } else {
    return newData;
  }
}

function swap16(val: number): number {
  return ((val & 0xff) << 8) | ((val >> 8) & 0xff);
}
