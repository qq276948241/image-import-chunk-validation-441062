import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { decode, decodeApng, encode } from '../index.ts';
import { BlendOpType, ColorType, DisposeOpType } from '../internal_types.ts';
import type { PngDecoderOptions } from '../types.ts';

import {
  assemblePng,
  makeIDAT,
  makeIEND,
  makeIHDR,
  makeRawRgba,
  parseChunks,
  truncate,
  writeChunk,
  writeChunkWithBadCrc,
} from './png_builder.ts';

const pngSignatureLength = 8;

function decodeBytes(
  bytes: Uint8Array,
  options?: PngDecoderOptions,
): ReturnType<typeof decode> {
  return decode(bytes, options);
}

/**
 * Serialize a tEXt chunk from raw chunk data.
 * @param data - Raw tEXt chunk data.
 * @returns The serialized chunk.
 */
function textChunk(data: Uint8Array): Uint8Array {
  return writeChunk({ type: 'tEXt', data });
}

function indexedPngWith(chunk: Uint8Array): Uint8Array {
  return assemblePng([
    makeIHDR({
      width: 2,
      height: 2,
      colorType: ColorType.INDEXED_COLOUR,
    }),
    chunk,
    makeIDAT(makeRawRgba(2, 2)),
    makeIEND(),
  ]);
}

function idatWith(raw: Uint8Array): Uint8Array {
  return writeChunk({ type: 'IDAT', data: zlibSync(raw) });
}

function makeFcTL(
  sequenceNumber: number,
  width: number,
  height: number,
  xOffset = 0,
  yOffset = 0,
): Uint8Array {
  const data = new Uint8Array(26);
  const view = new DataView(data.buffer);
  view.setUint32(0, sequenceNumber);
  view.setUint32(4, width);
  view.setUint32(8, height);
  view.setUint32(12, xOffset);
  view.setUint32(16, yOffset);
  view.setUint16(20, 100); // delay numerator
  view.setUint16(22, 1000); // delay denominator
  data[24] = DisposeOpType.NONE;
  data[25] = BlendOpType.SOURCE;
  return writeChunk({ type: 'fcTL', data });
}

function makeFdAT(sequenceNumber: number, raw: Uint8Array): Uint8Array {
  const compressed = zlibSync(raw);
  const data = new Uint8Array(4 + compressed.length);
  new DataView(data.buffer).setUint32(0, sequenceNumber);
  data.set(compressed, 4);
  return writeChunk({ type: 'fdAT', data });
}

function makeAcTL(numberOfFrames: number): Uint8Array {
  const data = new Uint8Array(8);
  const view = new DataView(data.buffer);
  view.setUint32(0, numberOfFrames);
  view.setUint32(4, 0); // infinite looping
  return writeChunk({ type: 'acTL', data });
}

function twoFrameApng(): Uint8Array {
  const raw = makeRawRgba(2, 2);
  return assemblePng([
    makeIHDR({ width: 2, height: 2 }),
    makeAcTL(2),
    makeFcTL(0, 2, 2),
    makeIDAT(raw),
    makeFcTL(1, 2, 2),
    makeFdAT(2, raw),
    makeIEND(),
  ]);
}

/**
 * Fields that can be overridden when building a potentially invalid IHDR.
 */
interface IhdrFieldOverrides {
  /** Bit depth value, defaults to 8. */
  depth?: number;
  /** Color type value, defaults to truecolour with alpha. */
  colorType?: number;
  /** Compression method value, defaults to deflate. */
  compression?: number;
  /** Filter method value, defaults to adaptive. */
  filter?: number;
  /** Interlace method value, defaults to no interlacing. */
  interlace?: number;
}

/**
 * Build a 2x2 IHDR chunk from raw field bytes, allowing invalid values.
 * @param fields - IHDR field overrides.
 * @returns The serialized IHDR chunk.
 */
function ihdrWithFields(fields: IhdrFieldOverrides): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2);
  view.setUint32(4, 2);
  data[8] = fields.depth ?? 8;
  data[9] = fields.colorType ?? ColorType.TRUECOLOUR_ALPHA;
  data[10] = fields.compression ?? 0;
  data[11] = fields.filter ?? 0;
  data[12] = fields.interlace ?? 0;
  return writeChunk({ type: 'IHDR', data });
}

/**
 * Build a minimal valid 2x2 RGBA PNG and return its serialized bytes together
 * with the byte ranges of every chunk so truncation tests can target precise
 * positions.
 * @returns The PNG bytes and the byte range of each chunk.
 */
function buildMinimalPng(): {
  bytes: Uint8Array;
  chunkRanges: Array<{ start: number; end: number; type: string }>;
} {
  const chunks = [
    makeIHDR({ width: 2, height: 2 }),
    makeIDAT(makeRawRgba(2, 2)),
    makeIEND(),
  ];
  const bytes = assemblePng(chunks);
  const ranges: Array<{ start: number; end: number; type: string }> = [];
  let offset = pngSignatureLength;
  for (const chunk of chunks) {
    const type = new TextDecoder().decode(chunk.subarray(4, 8));
    ranges.push({ start: offset, end: offset + chunk.length, type });
    offset += chunk.length;
  }
  return { bytes, chunkRanges: ranges };
}

describe('robust chunk boundary validation', () => {
  it('decodes a PNG assembled from independently serialized chunks', () => {
    const { bytes } = buildMinimalPng();
    const decoded = decodeBytes(bytes);

    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(decoded.data).toHaveLength(16);
  });

  it('rejects every truncation position with a format error', () => {
    const { bytes, chunkRanges } = buildMinimalPng();

    expect(chunkRanges.length).toBeGreaterThan(0);

    let checkedPositions = 0;
    for (const range of chunkRanges) {
      // Truncate at every byte from the chunk's first length byte up to and
      // including one byte before its end.
      for (let cut = range.start; cut < range.end; cut++) {
        const truncated = truncate(bytes, cut);

        expect(() => decodeBytes(truncated)).toThrowError(
          /Truncated|wrong PNG signature|Invalid|Unsupported/,
        );

        checkedPositions++;
      }
    }

    expect(checkedPositions).toBe(bytes.length - pngSignatureLength);

    // Also reject truncation inside the PNG signature.
    for (let cut = 0; cut < pngSignatureLength; cut++) {
      expect(() => decodeBytes(truncate(bytes, cut))).toThrowError(
        'wrong PNG signature',
      );
    }
  });

  it('never surfaces a native out-of-bounds error on truncated input', () => {
    const { bytes } = buildMinimalPng();
    const nativeErrorNames: string[] = [];
    for (let cut = 0; cut < bytes.length; cut++) {
      try {
        decodeBytes(truncate(bytes, cut));
      } catch (error) {
        if ((error as Error).name !== 'PngFormatError') {
          nativeErrorNames.push((error as Error).name);
        }
      }
    }

    expect(nativeErrorNames).toStrictEqual([]);
  });

  it('accepts a legal unknown ancillary chunk and skips it', () => {
    const ancillary = writeChunk({
      type: 'xTst', // lowercase first letter => ancillary
      data: Uint8Array.of(1, 2, 3, 4, 5),
    });
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      ancillary,
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).not.toThrowError();
    expect(decodeBytes(bytes).data).toHaveLength(16);
  });

  it('rejects an unknown critical chunk with its name and offset', () => {
    const critical = writeChunk({
      type: 'XZZZ', // uppercase first letter => critical
      data: Uint8Array.of(0),
    });
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      critical,
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /Unsupported critical chunk XZZZ/,
    );

    // The error mentions the byte offset of the offending chunk.
    const criticalOffset = pngSignatureLength + 25; // 25 = IHDR chunk size

    expect(() => decodeBytes(bytes)).toThrowError(
      `byte offset ${criticalOffset}`,
    );
  });

  it('rejects a chunk whose declared length runs past the end of the file', () => {
    const { bytes, chunkRanges } = buildMinimalPng();
    const idatRange = chunkRanges[1];
    const tampered = bytes.slice();
    const view = new DataView(
      tampered.buffer,
      tampered.byteOffset + idatRange.start,
      4,
    );
    view.setUint32(0, 1_000_000);

    expect(() => decodeBytes(tampered)).toThrowError(/Truncated chunk IDAT/);
  });

  it('requires IHDR to appear first', () => {
    const bytes = assemblePng([
      writeChunk({ type: 'tEXt', data: Uint8Array.of(65, 0, 66) }),
      makeIHDR({ width: 2, height: 2 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /IHDR chunk at byte offset .* must be the first/,
    );
  });

  it('rejects a second IHDR chunk', () => {
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      makeIHDR({ width: 2, height: 2 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(/Duplicate IHDR/);
  });

  it('rejects an IEND chunk with a non-zero length', () => {
    const badIend = writeChunk({ type: 'IEND', data: Uint8Array.of(0) });
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      makeIDAT(makeRawRgba(2, 2)),
      badIend,
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /IEND chunk.*must have zero length/,
    );
  });

  it('rejects invalid chunk type bytes with the offending type', () => {
    // Build a chunk header by hand with a non-letter type byte.
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0);
    header.set([0x49, 0x44, 0x41, 0x31], 4); // "IDA1"
    view.setUint32(8, 0); // dummy crc
    const bytes = assemblePng([makeIHDR({ width: 2, height: 2 }), header]);

    expect(() => decodeBytes(bytes)).toThrowError(/Invalid chunk type/);
  });

  it.each([{ checkCrc: false }, { checkCrc: true }])(
    'structural checks hold with checkCrc=$checkCrc',
    ({ checkCrc }) => {
      const { bytes } = buildMinimalPng();
      const truncated = truncate(bytes, bytes.length - 3);

      expect(() => decodeBytes(truncated, { checkCrc })).toThrowError(
        /Truncated|wrong PNG signature/,
      );
    },
  );

  it('still reports a bad CRC when checkCrc is enabled and accepts it otherwise', () => {
    const badCrcChunks = [
      makeIHDR({ width: 2, height: 2 }),
      writeChunkWithBadCrc({
        type: 'tEXt',
        data: Uint8Array.of(65, 0, 66), // "A" NUL "B"
      }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ];
    const bytes = assemblePng(badCrcChunks);

    expect(() => decodeBytes(bytes, { checkCrc: true })).toThrowError(
      /CRC mismatch for chunk tEXt/,
    );
    expect(() => decodeBytes(bytes, { checkCrc: false })).not.toThrowError();
  });

  it('rejects an invalid bit depth in the IHDR chunk', () => {
    const bytes = assemblePng([
      ihdrWithFields({ depth: 7 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(/invalid bit depth: 7/);
  });

  it('rejects an unknown color type in the IHDR chunk', () => {
    const bytes = assemblePng([
      ihdrWithFields({ colorType: 9 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(/Unknown color type: 9/);
  });

  it('rejects an unsupported compression method in the IHDR chunk', () => {
    const bytes = assemblePng([
      ihdrWithFields({ compression: 1 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /Unsupported compression method: 1/,
    );
  });

  it('rejects an unsupported filter method in the IHDR chunk', () => {
    const bytes = assemblePng([
      ihdrWithFields({ filter: 1 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /Filter method 1 not supported/,
    );
  });

  it('rejects an unsupported interlace method in the IHDR chunk', () => {
    const bytes = assemblePng([
      ihdrWithFields({ interlace: 2 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /Interlace method 2 not supported/,
    );
  });

  it('rejects zero width or height in the IHDR chunk', () => {
    const bytes = assemblePng([
      makeIHDR({ width: 0, height: 2 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(/zero width or height/);
  });
});

describe('text chunk parsing', () => {
  it('restores keywords as single-byte latin1 without windows-1252 remapping', () => {
    // Keyword "Ké" where é is the raw byte 0xE9, plus NUL and a value
    // containing C1 control bytes 0x80 and 0x9F.
    const data = Uint8Array.of(0x4b, 0xe9, 0x00, 0x80, 0x9f, 0x41);
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      textChunk(data),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);
    const decoded = decodeBytes(bytes);
    const keyword = 'Ké';

    expect(decoded.text[keyword]).toBeDefined();
    // 0x80/0x9F stay control characters, they are not remapped to € / Ÿ.
    expect(decoded.text[keyword]).toBe(String.fromCodePoint(0x80, 0x9f, 0x41));
  });

  it('rejects a text chunk without a keyword NULL terminator', () => {
    // The whole chunk is keyword bytes, no separator: the scan must stop at
    // the chunk boundary instead of reading through the CRC.
    const data = Uint8Array.of(65, 66, 67); // "ABC"
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      textChunk(data),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /missing NULL separator after keyword/,
    );
  });

  it('does not cross the CRC when looking for the terminator', () => {
    // Chunk data has no NUL, so the parser must reject before touching the
    // CRC or the next chunk.
    const chunk = textChunk(Uint8Array.of(65, 66));
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      chunk,
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(/Malformed tEXt/);
  });

  it('keeps the existing overwrite convention for repeated keywords', () => {
    const first = textChunk(Uint8Array.of(65, 0, 49)); // A => "1"
    const second = textChunk(Uint8Array.of(65, 0, 50)); // A => "2"
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      first,
      second,
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(decodeBytes(bytes).text).toStrictEqual({ A: '2' });
  });

  it('rejects a truncated text chunk even with CRC checking disabled', () => {
    const chunk = textChunk(Uint8Array.of(65, 66, 67));
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      chunk,
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes, { checkCrc: false })).toThrowError(
      /missing NULL separator/,
    );
  });

  it('keeps iCCP keyword scanning inside the chunk boundary', () => {
    const iccp = writeChunk({
      type: 'iCCP',
      data: Uint8Array.of(65, 66, 67, 0, 0),
    });
    const noSeparator = writeChunk({
      type: 'iCCP',
      data: Uint8Array.of(65, 66, 67),
    });
    const base = [
      makeIHDR({ width: 2, height: 2 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ] as Uint8Array[];

    expect(() => decodeBytes(assemblePng([iccp, ...base]))).toThrowError(
      /iCCP|decompress/,
    );
    expect(() => decodeBytes(assemblePng([noSeparator, ...base]))).toThrowError(
      /missing NULL separator after keyword/,
    );
  });
});

describe('palette and transparency validation', () => {
  it('rejects a PLTE chunk whose length is not a multiple of 3', () => {
    const chunk = writeChunk({
      type: 'PLTE',
      data: Uint8Array.of(0, 0, 0, 255),
    });

    expect(() => decodeBytes(indexedPngWith(chunk))).toThrowError(
      /PLTE chunk.*multiple of 3/,
    );
  });

  it('rejects a PLTE chunk with more than 256 entries', () => {
    const chunk = writeChunk({
      type: 'PLTE',
      data: new Uint8Array(257 * 3),
    });

    expect(() => decodeBytes(indexedPngWith(chunk))).toThrowError(
      /at most 256/,
    );
  });

  it('rejects a tRNS chunk longer than the palette', () => {
    const plte = writeChunk({
      type: 'PLTE',
      data: Uint8Array.of(0, 0, 0, 1, 1, 1),
    });
    const trns = writeChunk({ type: 'tRNS', data: Uint8Array.of(0, 0, 0) });
    const bytes = assemblePng([
      makeIHDR({
        width: 2,
        height: 2,
        colorType: ColorType.INDEXED_COLOUR,
      }),
      plte,
      trns,
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /tRNS chunk.*more alpha values than.*palette/,
    );
  });

  it('rejects a tRNS chunk with an odd length for truecolour', () => {
    const trns = writeChunk({
      type: 'tRNS',
      data: Uint8Array.of(0, 0, 0),
    });
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2, colorType: ColorType.TRUECOLOUR }),
      trns,
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(/tRNS chunk.*multiple of 2/);
  });

  it('reports malformed palette/transparency as format errors, not native ones', () => {
    const plte = writeChunk({ type: 'PLTE', data: Uint8Array.of(0) });

    expect(() => decodeBytes(indexedPngWith(plte))).toThrowError(
      /PLTE chunk.*multiple of 3/,
    );

    let caught: unknown;
    try {
      decodeBytes(indexedPngWith(plte));
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).name).toBe('PngFormatError');
  });
});

describe('decompression and pixel restoration limits', () => {
  it('rejects decompressed data that is too short for the dimensions', () => {
    const shortRaw = makeRawRgba(2, 1); // one scanline instead of two
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      idatWith(shortRaw),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /Decompressed data length mismatch/,
    );
  });

  it('rejects decompressed data that is too long instead of dropping bytes', () => {
    const longRaw = makeRawRgba(2, 3); // three scanlines instead of two
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      idatWith(longRaw),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(
      /Decompressed data length mismatch/,
    );
  });

  it('reports a corrupted zlib stream as a format error, not a native one', () => {
    const good = idatWith(makeRawRgba(2, 2));
    // Flip bytes in the middle of the compressed payload while keeping the
    // chunk framing and CRC internally consistent via the independent builder.
    const payloadStart = 8;
    const payloadEnd = good.length - 4;
    const corruptedPayload = good
      .subarray(payloadStart, payloadEnd)
      .map((byte) => byte ^ 0xff);
    const corrupted = writeChunk({ type: 'IDAT', data: corruptedPayload });
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      corrupted,
      makeIEND(),
    ]);
    let caught: unknown;
    try {
      decodeBytes(bytes);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe('PngFormatError');
  });

  it('rejects an unsupported filter byte with a format error', () => {
    const raw = makeRawRgba(2, 2);
    raw[0] = 9; // invalid filter type on the first scanline
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      idatWith(raw),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes)).toThrowError(/Unsupported filter: 9/);
  });

  it('honours maxOutputSize for a non-interlaced image', () => {
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes, { maxOutputSize: 15 })).toThrowError(
      /exceeds the configured limit/,
    );
    expect(() => decodeBytes(bytes, { maxOutputSize: 16 })).not.toThrowError();
  });

  it('rejects oversized declared dimensions before allocating', () => {
    const bytes = assemblePng([
      makeIHDR({ width: 0xffffffff, height: 0xffffffff }),
      makeIDAT(makeRawRgba(2, 2)),
      makeIEND(),
    ]);

    expect(() => decodeBytes(bytes, { maxOutputSize: 1024 })).toThrowError(
      /exceeds the configured limit|Integer overflow/,
    );
  });

  it('decodes a small interlaced image assembled from chunks', () => {
    const pixelData = new Uint8Array([
      10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160,
    ]);
    const encoded = encode(
      { width: 2, height: 2, data: pixelData },
      { interlace: 'Adam7' },
    );
    // Re-serialize through the independent chunk builder.
    const chunks = parseChunks(encoded).map((chunk) => writeChunk(chunk));
    const rebuilt = assemblePng(chunks);
    const decoded = decodeBytes(rebuilt);

    expect(decoded.data).toStrictEqual(pixelData);
  });

  it('decodes a small interlaced sub-byte image through every Adam7 pass', () => {
    // 8x1 greyscale 1-bit image, built by hand so the test validates the
    // decoder against the PNG spec instead of relying on an encoder round
    // trip. Final packed scanline is 0b10110100:
    //   x0=1 x1=0 x2=1 x3=1 x4=0 x5=1 x6=0 x7=0
    // For a one-row image only passes 1, 2, 4 and 6 contain data; each
    // contributes one filter byte followed by one packed sample byte.
    const passData = [
      0b10000000, // pass 1: x0 = 1
      0b00000000, // pass 2: x4 = 0
      0b10000000, // pass 4: samples [x2 = 1, x6 = 0]
      0b01100000, // pass 6: samples [x1 = 0, x3 = 1, x5 = 1, x7 = 0]
    ];
    const raw = new Uint8Array(passData.length * 2);
    for (let index = 0; index < passData.length; index++) {
      raw[index * 2] = 0; // filter type: none
      raw[index * 2 + 1] = passData[index];
    }
    const bytes = assemblePng([
      makeIHDR({
        width: 8,
        height: 1,
        depth: 1,
        colorType: ColorType.GREYSCALE,
        interlace: 1,
      }),
      idatWith(raw),
      makeIEND(),
    ]);
    const decoded = decodeBytes(bytes);

    expect(decoded.data).toStrictEqual(Uint8Array.of(0b10110100));
  });

  it('decodes a multi-row interlaced 2-bit image with packed samples', () => {
    // 4x4 greyscale 2-bit image, hand-built so every non-empty Adam7 pass
    // contributes data across several rows.
    const imageWidth = 4;
    const imageHeight = 4;
    const depth = 2;
    const finalRows = [
      Uint8Array.of(0b00_01_10_11),
      Uint8Array.of(0b11_10_01_00),
      Uint8Array.of(0b01_01_10_10),
      Uint8Array.of(0b10_11_00_01),
    ];
    const passes = [
      { x: 0, y: 0, xStep: 8, yStep: 8 },
      { x: 4, y: 0, xStep: 8, yStep: 8 },
      { x: 0, y: 4, xStep: 4, yStep: 8 },
      { x: 2, y: 0, xStep: 4, yStep: 4 },
      { x: 0, y: 2, xStep: 2, yStep: 4 },
      { x: 1, y: 0, xStep: 2, yStep: 2 },
      { x: 0, y: 1, xStep: 1, yStep: 2 },
    ];
    const samplesPerByte = 8 / depth;
    const rawParts: number[] = [];
    for (const pass of passes) {
      const passWidth = Math.ceil((imageWidth - pass.x) / pass.xStep);
      const passHeight = Math.ceil((imageHeight - pass.y) / pass.yStep);
      if (passWidth <= 0 || passHeight <= 0) continue;
      // ceil(passWidth * depth / 8), the PNG scanline byte count.
      const lineBytes = Math.ceil((passWidth * depth) / 8);
      for (let py = 0; py < passHeight; py++) {
        rawParts.push(0); // filter type: none
        const line = new Uint8Array(lineBytes);
        for (let px = 0; px < passWidth; px++) {
          const imageX = pass.x + px * pass.xStep;
          const imageY = pass.y + py * pass.yStep;
          const sample =
            (finalRows[imageY][Math.floor(imageX / samplesPerByte)] >>
              ((samplesPerByte - 1 - (imageX % samplesPerByte)) * depth)) &
            ((1 << depth) - 1);
          line[Math.floor(px / samplesPerByte)] |=
            sample << ((samplesPerByte - 1 - (px % samplesPerByte)) * depth);
        }
        rawParts.push(...line);
      }
    }
    const bytes = assemblePng([
      makeIHDR({
        width: imageWidth,
        height: imageHeight,
        depth,
        colorType: ColorType.GREYSCALE,
        interlace: 1,
      }),
      idatWith(Uint8Array.from(rawParts)),
      makeIEND(),
    ]);
    const decoded = decodeBytes(bytes);

    expect(decoded.data).toStrictEqual(
      Uint8Array.from([
        ...finalRows[0],
        ...finalRows[1],
        ...finalRows[2],
        ...finalRows[3],
      ]),
    );
  });

  it('rejects truncated interlaced scanline data as a format error', () => {
    const encoded = encode(
      {
        width: 4,
        height: 4,
        data: new Uint8Array(4 * 4 * 4).fill(7),
      },
      { interlace: 'Adam7' },
    );
    const chunks = parseChunks(encoded);
    const idat = chunks.find((chunk) => chunk.type === 'IDAT');

    expect(idat).toBeDefined();

    // Truncate the IDAT data field itself while keeping valid chunk framing.
    const shortened = writeChunk({
      type: 'IDAT',
      data: (idat as { data: Uint8Array }).data.subarray(0, -2),
    });
    const rebuilt = assemblePng([
      ...chunks
        .filter((chunk) => chunk.type !== 'IDAT')
        .map((chunk) => writeChunk(chunk)),
      shortened,
    ]);
    let caught: unknown;
    try {
      decodeBytes(rebuilt);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    // Decompression failures must be reported as format errors, never as the
    // inflator's native error type.
    expect((caught as Error).name).toBe('PngFormatError');
  });

  it('keeps decoding legal images identically when no limit is configured', () => {
    const pixelData = new Uint8Array(16).fill(123);
    const encoded = encode({ width: 2, height: 2, data: pixelData });

    expect(decodeBytes(encoded).data).toStrictEqual(pixelData);
  });
});

describe('APNG frame validation', () => {
  it('decodes a valid two-frame animation assembled from chunks', () => {
    const decoded = decodeApng(twoFrameApng());

    expect(decoded.frames).toHaveLength(2);
    expect(decoded.frames[0].data).toHaveLength(16);
  });

  it('rejects a frame extending outside the image canvas', () => {
    const raw = makeRawRgba(2, 2);
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      makeAcTL(1),
      makeFcTL(0, 2, 2, 1, 1), // offset (1,1) overflows the 2x2 canvas
      makeFdAT(1, raw),
      makeIEND(),
    ]);

    expect(() => decodeApng(bytes)).toThrowError(/outside the 2x2 image/);
  });

  it('rejects an out-of-order sequence number', () => {
    const raw = makeRawRgba(2, 2);
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      makeAcTL(2),
      makeFcTL(0, 2, 2),
      makeIDAT(raw),
      makeFcTL(5, 2, 2), // expected 1
      makeFdAT(6, raw),
      makeIEND(),
    ]);

    expect(() => decodeApng(bytes)).toThrowError(
      /sequence number 5, expected 1/,
    );
  });

  it('rejects an fcTL frame count that does not match acTL', () => {
    const raw = makeRawRgba(2, 2);
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      makeAcTL(3), // declares 3 frames
      makeFcTL(0, 2, 2),
      makeIDAT(raw),
      makeFcTL(1, 2, 2),
      makeFdAT(2, raw),
      makeIEND(),
    ]);

    expect(() => decodeApng(bytes)).toThrowError(
      /acTL declares 3 frames but the file contains only 2/,
    );
  });

  it('accumulates the output budget across frames', () => {
    const bytes = twoFrameApng();

    // One frame costs 16 output bytes; allow one frame but not two.
    expect(() => decodeApng(bytes, { maxOutputSize: 16 })).toThrowError(
      /exceeds the configured limit/,
    );
    expect(() => decodeApng(bytes, { maxOutputSize: 32 })).not.toThrowError();
  });

  it('cannot bypass the per-frame limit through many small frames', () => {
    const raw = makeRawRgba(2, 2);
    const frameCount = 10;
    const chunks: Uint8Array[] = [
      makeIHDR({ width: 2, height: 2 }),
      makeAcTL(frameCount),
    ];
    let sequence = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      chunks.push(makeFcTL(sequence++, 2, 2));
      if (frame === 0) {
        chunks.push(makeIDAT(raw));
      } else {
        chunks.push(makeFdAT(sequence++, raw));
      }
    }
    chunks.push(makeIEND());
    const bytes = assemblePng(chunks);

    // 10 frames * 16 bytes = 160 total; cap below that must reject.
    expect(() => decodeApng(bytes, { maxOutputSize: 100 })).toThrowError(
      /exceeds the configured limit/,
    );
    expect(() => decodeApng(bytes, { maxOutputSize: 160 })).not.toThrowError();
  });

  it('rejects a frame whose decompressed size does not match its dimensions', () => {
    const raw = makeRawRgba(2, 1); // only one scanline
    const bytes = assemblePng([
      makeIHDR({ width: 2, height: 2 }),
      makeAcTL(1),
      makeFcTL(0, 2, 2),
      makeFdAT(1, raw),
      makeIEND(),
    ]);

    expect(() => decodeApng(bytes)).toThrowError(
      /decompressed to .* bytes, expected/,
    );
  });

  it('rejects malformed acTL/fcTL/fdAT chunk lengths', () => {
    const raw = makeRawRgba(2, 2);
    const shortActl = writeChunk({
      type: 'acTL',
      data: new Uint8Array(4),
    });

    expect(() =>
      decodeApng(
        assemblePng([
          makeIHDR({ width: 2, height: 2 }),
          shortActl,
          makeFcTL(0, 2, 2),
          makeFdAT(1, raw),
          makeIEND(),
        ]),
      ),
    ).toThrowError(/acTL chunk.*must have length 8/);

    const shortFctl = writeChunk({
      type: 'fcTL',
      data: new Uint8Array(10),
    });

    expect(() =>
      decodeApng(
        assemblePng([
          makeIHDR({ width: 2, height: 2 }),
          makeAcTL(1),
          shortFctl,
          makeFdAT(1, raw),
          makeIEND(),
        ]),
      ),
    ).toThrowError(/fcTL chunk.*must have length 26/);

    const emptyFdat = writeChunk({
      type: 'fdAT',
      data: new Uint8Array(0),
    });

    expect(() =>
      decodeApng(
        assemblePng([
          makeIHDR({ width: 2, height: 2 }),
          makeAcTL(1),
          makeFcTL(0, 2, 2),
          emptyFdat,
          makeIEND(),
        ]),
      ),
    ).toThrowError(/fdAT chunk.*at least 4 bytes/);
  });
});
