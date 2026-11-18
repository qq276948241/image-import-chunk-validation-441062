import type { IOBuffer } from 'iobuffer';

import { writeCrc } from './crc.ts';
import { PngFormatError } from './error.ts';

// https://www.w3.org/TR/png/#11tEXt

export const textChunkName = 'tEXt';

const NULL = 0;
const MAX_KEYWORD_LENGTH = 79;
const LATIN1_MAX_CODE_POINT = 255;

function validateKeyword(keyword: string) {
  validateLatin1(keyword);
  if (keyword.length === 0 || keyword.length > MAX_KEYWORD_LENGTH) {
    throw new PngFormatError(
      `tEXt keyword length must be between 1 and ${MAX_KEYWORD_LENGTH}, got ${keyword.length}`,
    );
  }
}

function validateLatin1(text: string) {
  for (let i = 0; i < text.length; i++) {
    if ((text.codePointAt(i) ?? 0) > LATIN1_MAX_CODE_POINT) {
      throw new PngFormatError('invalid latin1 text');
    }
  }
}

/**
 * Decode bytes according to the PNG "latin1" text convention: every byte is
 * mapped to the Unicode code point with the same value. This deliberately
 * avoids the WHATWG windows-1252 mapping (used by TextDecoder('latin1') in
 * browsers), which remaps the C1 control range 0x80-0x9F to printable
 * characters.
 * https://www.w3.org/TR/png/#11tEXt
 * @param bytes - Bytes to decode.
 * @returns The decoded string, one code point per input byte.
 */
export function decodeLatin1(bytes: Uint8Array): string {
  let result = '';
  // Code points are appended in chunks to avoid argument-length limits.
  const chunkSize = 0x1000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    result += String.fromCodePoint(...chunk);
  }
  return result;
}

/**
 * Decode a tEXt chunk into the target dictionary. Repeated keywords keep the
 * existing overwrite convention.
 * @param text - Dictionary that receives the decoded key/value pair.
 * @param buffer - Buffer positioned at the start of the chunk data.
 * @param length - Total length of the chunk data in bytes.
 */
export function decodetEXt(
  text: Record<string, string>,
  buffer: IOBuffer,
  length: number,
) {
  const keyword = readKeyword(buffer, length, textChunkName);
  // One byte is consumed by the keyword NULL separator.
  const valueLength = length - keyword.length - 1;
  if (valueLength < 0) {
    throw new PngFormatError(
      `Malformed ${textChunkName} chunk: keyword separator is missing`,
    );
  }
  // Repeated keywords keep the existing overwrite convention.
  text[keyword] = readLatin1(buffer, valueLength);
}

/**
 * Encode and write a tEXt chunk, including its CRC.
 * @param buffer - Buffer the chunk is written to.
 * @param keyword - Latin1 keyword of at most 79 bytes.
 * @param text - Latin1 text value.
 */
export function encodetEXt(buffer: IOBuffer, keyword: string, text: string) {
  validateKeyword(keyword);
  validateLatin1(text);
  const length = keyword.length + 1 /* NULL */ + text.length;

  buffer.writeUint32(length);
  buffer.writeChars(textChunkName);
  buffer.writeChars(keyword);
  buffer.writeByte(NULL);
  buffer.writeChars(text);
  writeCrc(buffer, length + 4);
}

// https://www.w3.org/TR/png/#11keywords
/**
 * Read a NULL-terminated keyword without ever reading past the end of the
 * enclosing chunk. `chunkLength` is the number of bytes still belonging to
 * the chunk at the keyword's start.
 * @param buffer - Buffer positioned at the start of the keyword.
 * @param chunkLength - Bytes still belonging to the enclosing chunk.
 * @param chunkName - Name of the enclosing chunk, used in error messages.
 * @returns The validated keyword.
 */
export function readKeyword(
  buffer: IOBuffer,
  chunkLength: number,
  chunkName: string,
): string {
  const start = buffer.offset;
  const limit = start + chunkLength;
  let separator = -1;
  for (let i = start; i < limit; i++) {
    if (buffer.readByte() === NULL) {
      separator = i;
      break;
    }
  }
  if (separator === -1) {
    // Do not cross the CRC (or the next chunk) looking for the terminator.
    throw new PngFormatError(
      `Malformed ${chunkName} chunk at byte offset ${start}: missing NULL separator after keyword`,
    );
  }
  const keywordBytes = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset + start,
    separator - start,
  );
  const keyword = decodeLatin1(keywordBytes);
  // The readByte() loop already consumed the NULL separator.

  validateKeyword(keyword);

  return keyword;
}

/**
 * Read a fixed number of bytes and decode them as PNG latin1 text.
 * @param buffer - Source buffer.
 * @param length - Number of bytes to read.
 * @returns The decoded string.
 */
export function readLatin1(buffer: IOBuffer, length: number): string {
  return decodeLatin1(buffer.readBytes(length));
}
