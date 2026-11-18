import { applyUnfilter } from './apply_unfilter.ts';
import type { DecodeInterlaceNullParams } from './decode_interlace_null.ts';
import { PngFormatError } from './error.ts';
import {
  INTERLACE_ADAM7,
  bytesPerScanline,
  expectedOutputSize,
  expectedRawDataSize,
} from './png_size.ts';
import { checkOutputBudget } from './safe_math.ts';

const uint16 = new Uint16Array([0x00ff]);
const uint8 = new Uint8Array(uint16.buffer);
const osIsLittleEndian = uint8[0] === 0xff;

// Adam7 interlacing pattern
const passes = [
  { x: 0, y: 0, xStep: 8, yStep: 8 }, // Pass 1
  { x: 4, y: 0, xStep: 8, yStep: 8 }, // Pass 2
  { x: 0, y: 4, xStep: 4, yStep: 8 }, // Pass 3
  { x: 2, y: 0, xStep: 4, yStep: 4 }, // Pass 4
  { x: 0, y: 2, xStep: 2, yStep: 4 }, // Pass 5
  { x: 1, y: 0, xStep: 2, yStep: 2 }, // Pass 6
  { x: 0, y: 1, xStep: 1, yStep: 2 }, // Pass 7
];

/**
 * Decodes the Adam7 interlaced PNG data.
 * @param params - DecodeInterlaceNullParams
 * @returns - array of pixel data.
 */
export function decodeInterlaceAdam7(params: DecodeInterlaceNullParams) {
  const {
    data,
    width,
    height,
    channels,
    depth,
    maxOutputSize = Number.POSITIVE_INFINITY,
  } = params;

  const bytesPerPixel = Math.ceil(depth / 8) * channels;
  const subByte = depth < 8;
  const samplesPerByte = subByte ? 8 / depth : 1;

  const expectedLength = expectedRawDataSize({
    width,
    height,
    channels,
    depth,
    interlaceMethod: INTERLACE_ADAM7,
  });
  if (data.length !== expectedLength) {
    throw new PngFormatError(
      `Decompressed data length mismatch: expected ${expectedLength} bytes for interlaced ${width}x${height} image, got ${data.length}`,
    );
  }

  const outputSize = expectedOutputSize({
    width,
    height,
    channels,
    depth,
    interlaceMethod: INTERLACE_ADAM7,
  });
  checkOutputBudget(outputSize, maxOutputSize);

  const resultData = new Uint8Array(outputSize);

  let offset = 0;

  // Process each pass
  for (let passIndex = 0; passIndex < 7; passIndex++) {
    const pass = passes[passIndex];

    // Calculate pass dimensions
    const passWidth = Math.ceil((width - pass.x) / pass.xStep);
    const passHeight = Math.ceil((height - pass.y) / pass.yStep);

    if (passWidth <= 0 || passHeight <= 0) continue;

    // The size of every pass is validated up-front, so the reads below can
    // never cross the end of the decompressed stream.
    const passLineBytes = bytesPerScanline(passWidth, channels, depth);
    const passExpectedLength = passHeight * (passLineBytes + 1);
    if (offset + passExpectedLength > data.length) {
      throw new PngFormatError(
        `Truncated scanline data in Adam7 pass ${passIndex + 1}`,
      );
    }
    const prevLine = new Uint8Array(passLineBytes);

    // Process each scanline in this pass
    for (let y = 0; y < passHeight; y++) {
      // First byte is the filter type
      const filterType = data[offset++];
      const currentLine = data.subarray(offset, offset + passLineBytes);
      offset += passLineBytes;

      // Create a new line for the unfiltered data
      const newLine = new Uint8Array(passLineBytes);

      // Apply the appropriate unfilter
      applyUnfilter(
        filterType,
        currentLine,
        newLine,
        prevLine,
        passLineBytes,
        bytesPerPixel,
      );
      prevLine.set(newLine);

      for (let x = 0; x < passWidth; x++) {
        const outputX = pass.x + x * pass.xStep;
        const outputY = pass.y + y * pass.yStep;
        if (outputX >= width || outputY >= height) continue;
        if (subByte) {
          // Sub-byte samples are packed most-significant-bit first, one
          // channel per pixel. The source position uses the sample's index
          // inside the pass line while the destination position uses the
          // sample's final pixel index in the output image.
          const sourceByteIndex = Math.floor(x / samplesPerByte);
          const sourceShift =
            (samplesPerByte - 1 - (x % samplesPerByte)) * depth;
          const sample =
            (newLine[sourceByteIndex] >> sourceShift) & ((1 << depth) - 1);
          const outputByteIndex =
            outputY * bytesPerScanline(width, channels, depth) +
            Math.floor(outputX / samplesPerByte);
          const outputShift =
            (samplesPerByte - 1 - (outputX % samplesPerByte)) * depth;
          resultData[outputByteIndex] |= sample << outputShift;
        } else {
          for (let i = 0; i < bytesPerPixel; i++) {
            resultData[(outputY * width + outputX) * bytesPerPixel + i] =
              newLine[x * bytesPerPixel + i];
          }
        }
      }
    }
  }
  if (depth === 16) {
    const uint16Data = new Uint16Array(resultData.buffer);
    if (osIsLittleEndian) {
      for (let k = 0; k < uint16Data.length; k++) {
        // PNG is always big endian. Swap the bytes.
        uint16Data[k] = swap16(uint16Data[k]);
      }
    }
    return uint16Data;
  } else {
    return resultData;
  }
}

function swap16(val: number): number {
  return ((val & 0xff) << 8) | ((val >> 8) & 0xff);
}
