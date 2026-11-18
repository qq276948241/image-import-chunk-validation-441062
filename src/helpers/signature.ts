import type { IOBuffer } from 'iobuffer';

import { PngFormatError } from './error.ts';

// https://www.w3.org/TR/PNG/#5PNG-file-signature

const pngSignature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

/**
 * Write the 8-byte PNG signature at the current buffer position.
 * @param buffer - Target buffer.
 */
export function writeSignature(buffer: IOBuffer) {
  buffer.writeBytes(pngSignature);
}

/**
 * Read and validate the PNG signature, throwing a PngFormatError when the
 * input is too short or does not start with the signature.
 * @param buffer - Buffer positioned at the start of the file.
 */
export function checkSignature(buffer: IOBuffer) {
  if (buffer.length < pngSignature.length) {
    throw new PngFormatError(
      `wrong PNG signature: expected ${pngSignature.length} bytes but only ${buffer.length} remain`,
    );
  }
  if (!hasPngSignature(buffer.readBytes(pngSignature.length))) {
    throw new PngFormatError('wrong PNG signature');
  }
}

/**
 * Check whether a byte sequence starts with the PNG signature.
 * @param array - Bytes to inspect.
 * @returns `true` when the leading bytes match the PNG signature.
 */
export function hasPngSignature(array: ArrayLike<number>) {
  if (array.length < pngSignature.length) {
    return false;
  }
  for (let i = 0; i < pngSignature.length; i++) {
    if (array[i] !== pngSignature[i]) {
      return false;
    }
  }
  return true;
}
