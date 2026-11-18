import { Unzlib as Inflator, unzlibSync } from 'fflate';
import { IOBuffer } from 'iobuffer';

import { checkCrc } from './helpers/crc.ts';
import { decodeInterlaceAdam7 } from './helpers/decode_interlace_adam7.ts';
import { decodeInterlaceNull } from './helpers/decode_interlace_null.ts';
import { PngFormatError } from './helpers/error.ts';
import { expectedOutputSize, expectedRawDataSize } from './helpers/png_size.ts';
import {
  checkOutputBudget,
  checkedAdd,
  checkedMultiply,
} from './helpers/safe_math.ts';
import { checkSignature } from './helpers/signature.ts';
import { decodetEXt, readKeyword, textChunkName } from './helpers/text.ts';
import {
  BlendOpType,
  ColorType,
  CompressionMethod,
  DisposeOpType,
  FilterMethod,
  InterlaceMethod,
} from './internal_types.ts';
import type {
  ApngFrame,
  BitDepth,
  DecodedApng,
  DecodedApngFrame,
  DecodedPng,
  DecoderInputType,
  IndexedColors,
  PngDataArray,
  PngDecoderOptions,
  ResolutionUnitSpecifier,
} from './types.ts';

interface ChunkHeader {
  length: number;
  type: string;
  /** Absolute offset of the length field, relative to the start of the PNG. */
  headerOffset: number;
}

const IHDR_LENGTH = 13;
const APNG_ACTL_LENGTH = 8;
const APNG_FCTL_LENGTH = 26;
const APNG_FDAT_MIN_LENGTH = 4;
const PHYS_LENGTH = 9;
const PALETTE_MAX_ENTRIES = 256;

export default class PngDecoder extends IOBuffer {
  private readonly _checkCrc: boolean;
  private readonly _maxOutputSize: number;
  private _inflator: Inflator;
  private readonly _png: DecodedPng;
  private readonly _apng: DecodedApng;
  private _end: boolean;
  private _hasIHDR: boolean;
  private _hasPalette: boolean;
  private _palette: IndexedColors;
  private _hasTransparency: boolean;
  private _transparency: Uint16Array;
  private _compressionMethod: CompressionMethod;
  private _filterMethod: FilterMethod;
  private _interlaceMethod: InterlaceMethod;
  private _colorType: ColorType;
  private _isAnimated: boolean;
  private _numberOfFrames: number;
  private _numberOfPlays: number;
  private _frames: ApngFrame[];
  private _writingDataChunks: boolean;
  private _chunks: Uint8Array[];
  private _inflatorResult: Uint8Array;
  /** Next expected APNG sequence number. */
  private _nextSequenceNumber: number;
  /** Output bytes already accounted for by previous animation frames. */
  private _usedOutputBudget: number;
  public constructor(data: DecoderInputType, options: PngDecoderOptions = {}) {
    super(data);
    const { checkCrc = false, maxOutputSize = Number.POSITIVE_INFINITY } =
      options;
    this._checkCrc = checkCrc;
    if (
      typeof maxOutputSize !== 'number' ||
      (!Number.isFinite(maxOutputSize) &&
        maxOutputSize !== Number.POSITIVE_INFINITY) ||
      maxOutputSize < 0
    ) {
      throw new TypeError(
        'maxOutputSize must be a non-negative number or Infinity',
      );
    }
    this._maxOutputSize = maxOutputSize;
    this._inflator = new Inflator((chunk, final) => {
      this._chunks.push(chunk);
      if (final) {
        this._inflatorResult = this._assembleInflatedChunks();
      }
    });
    this._chunks = [];
    this._png = {
      width: -1,
      height: -1,
      channels: -1,
      data: new Uint8Array(0),
      depth: 1,
      text: {},
    };
    this._apng = {
      width: -1,
      height: -1,
      channels: -1,
      depth: 1,
      numberOfFrames: 1,
      numberOfPlays: 0,
      text: {},
      frames: [],
    };
    this._end = false;
    this._hasIHDR = false;
    this._hasPalette = false;
    this._palette = [];
    this._hasTransparency = false;
    this._transparency = new Uint16Array(0);
    this._compressionMethod = CompressionMethod.UNKNOWN;
    this._filterMethod = FilterMethod.UNKNOWN;
    this._interlaceMethod = InterlaceMethod.UNKNOWN;
    this._colorType = ColorType.UNKNOWN;
    this._isAnimated = false;
    this._numberOfFrames = 1;
    this._numberOfPlays = 0;
    this._frames = [];
    this._writingDataChunks = false;
    this._inflatorResult = new Uint8Array(0);
    this._nextSequenceNumber = 0;
    this._usedOutputBudget = 0;
    // PNG is always big endian
    // https://www.w3.org/TR/PNG/#7Integers-and-byte-order
    this.setBigEndian();
  }

  private _assembleInflatedChunks(): Uint8Array {
    let totalLength = 0;
    for (const chunk of this._chunks) {
      totalLength = checkedAdd(totalLength, chunk.length);
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this._chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    this._chunks = [];
    return result;
  }

  public decode(): DecodedPng {
    checkSignature(this);
    this.readChunks(false);
    this.finalizeInflator();

    this.decodeImage();

    return this._png;
  }

  public decodeApng(): DecodedApng {
    checkSignature(this);
    this.readChunks(true);
    if (this._writingDataChunks) {
      this.pushDataToFrame();
    }
    this.decodeApngImage();
    return this._apng;
  }

  /**
   * Flush the current zlib stream, converting any decompression failure into
   * a PngFormatError so native errors never reach callers.
   */
  private finalizeInflator(): void {
    try {
      this._inflator.push(new Uint8Array(0), true);
    } catch (error) {
      throw new PngFormatError('Error while decompressing the data:', {
        cause: error,
      });
    }
  }

  private readChunks(animated: boolean): void {
    while (!this._end) {
      const header = this.readChunkHeader();
      if (animated) {
        this.decodeApngChunk(header);
      } else {
        this.decodeChunk(header);
      }
    }
  }

  /**
   * Read a chunk length/type pair after verifying that all 8 header bytes are
   * present. The data area and 4-byte CRC are checked separately so that
   * truncated files are rejected before any chunk content is read.
   * @returns The parsed chunk header with its absolute file offset.
   */
  private readChunkHeader(): ChunkHeader {
    const headerOffset = this.offset;
    if (!this.available(8)) {
      throw new PngFormatError(
        `Truncated chunk header at byte offset ${headerOffset}: expected 8 bytes but only ${this.length - headerOffset} remain`,
      );
    }
    const length = this.readUint32();
    const type = this.readChars(4);
    // After the 8-byte header the chunk needs `length` data bytes and 4 CRC
    // bytes. checkedAdd rejects absurd lengths that overflow a safe integer.
    const remainingSize = checkedAdd(length, 4);
    if (this.offset + remainingSize > this.length) {
      throw new PngFormatError(
        `Truncated chunk ${type} at byte offset ${headerOffset}: chunk declares ${length} data bytes plus 4 CRC bytes but only ${this.length - this.offset} bytes remain`,
      );
    }
    this.validateChunkType(type, headerOffset);
    return { length, type, headerOffset };
  }

  private validateChunkType(type: string, headerOffset: number): void {
    for (const character of type) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 65 || code > 122 || (code > 90 && code < 97)) {
        throw new PngFormatError(
          `Invalid chunk type "${type}" at byte offset ${headerOffset}: type bytes must be ASCII letters (A-Z, a-z)`,
        );
      }
    }
  }

  private static isCritical(type: string): boolean {
    // https://www.w3.org/TR/PNG/#5Chunk-naming-conventions
    return (type.codePointAt(0) ?? 0) < 97; // uppercase first letter
  }

  // https://www.w3.org/TR/PNG/#5Chunk-layout
  private decodeChunk(header: ChunkHeader): void {
    const { length, type } = header;
    const offset = this.offset;
    this.decodeChunkBody(header);
    if (this.offset - offset !== length) {
      throw new PngFormatError(
        `Length mismatch while decoding chunk ${type} at byte offset ${header.headerOffset}`,
      );
    }
    this.readCrc(length + 4, type);
  }

  private decodeChunkBody(header: ChunkHeader): void {
    const { length, type, headerOffset } = header;
    switch (type) {
      // 11.2 Critical chunks
      case 'IHDR': // 11.2.2 IHDR Image header
        this.decodeIHDR(length, headerOffset);
        break;
      case 'PLTE': // 11.2.3 PLTE Palette
        this.decodePLTE(length, headerOffset);
        break;
      case 'IDAT': // 11.2.4 IDAT Image data
        this.decodeIDAT(length);
        break;
      case 'IEND': // 11.2.5 IEND Image trailer
        if (length !== 0) {
          throw new PngFormatError(
            `IEND chunk at byte offset ${headerOffset} must have zero length, got ${length}`,
          );
        }
        this._end = true;
        break;
      // 11.3 Ancillary chunks
      case 'tRNS': // 11.3.2.1 tRNS Transparency
        this.decodetRNS(length, headerOffset);
        break;
      case 'iCCP': // 11.3.3.3 iCCP Embedded ICC profile
        this.decodeiCCP(length, headerOffset);
        break;
      case textChunkName: // 11.3.4.3 tEXt Textual data
        decodetEXt(this._png.text, this, length);
        break;
      case 'pHYs': // 11.3.5.3 pHYs Physical pixel dimensions
        this.decodepHYs(length, headerOffset);
        break;
      default:
        if (PngDecoder.isCritical(type)) {
          throw new PngFormatError(
            `Unsupported critical chunk ${type} at byte offset ${headerOffset}`,
          );
        }
        // Unknown ancillary chunks are legal and simply skipped.
        this.skip(length);
        break;
    }
  }

  private decodeApngChunk(header: ChunkHeader): void {
    const { length, type, headerOffset } = header;
    const offset = this.offset;
    if (type !== 'fdAT' && type !== 'IDAT' && this._writingDataChunks) {
      this.pushDataToFrame();
    }
    switch (type) {
      case 'acTL':
        this.decodeACTL(length, headerOffset);
        break;
      case 'fcTL':
        this.decodeFCTL(length, headerOffset);
        break;
      case 'fdAT':
        this.decodeFDAT(length, headerOffset);
        break;
      default:
        this.decodeChunkBody(header);
        break;
    }
    if (this.offset - offset !== length) {
      throw new PngFormatError(
        `Length mismatch while decoding chunk ${type} at byte offset ${headerOffset}`,
      );
    }
    this.readCrc(length + 4, type);
  }

  private readCrc(crcLength: number, type: string): void {
    if (this._checkCrc) {
      checkCrc(this, crcLength, type);
    } else {
      this.skip(4);
    }
  }

  // https://www.w3.org/TR/PNG/#11IHDR
  private decodeIHDR(length: number, headerOffset: number): void {
    if (this._hasIHDR) {
      throw new PngFormatError(
        `Duplicate IHDR chunk at byte offset ${headerOffset}: the image header may appear only once`,
      );
    }
    if (headerOffset !== 8) {
      throw new PngFormatError(
        `IHDR chunk at byte offset ${headerOffset} must be the first chunk, immediately after the 8-byte PNG signature`,
      );
    }
    if (length !== IHDR_LENGTH) {
      throw new PngFormatError(
        `IHDR chunk at byte offset ${headerOffset} must have length ${IHDR_LENGTH}, got ${length}`,
      );
    }
    this._hasIHDR = true;
    const image = this._png;

    image.width = this.readUint32();
    image.height = this.readUint32();
    if (image.width === 0 || image.height === 0) {
      throw new PngFormatError(
        `IHDR chunk at byte offset ${headerOffset} declares zero width or height (${image.width}x${image.height})`,
      );
    }
    image.depth = checkBitDepth(this.readUint8());

    const colorType = this.readUint8() as ColorType;
    this._colorType = colorType;
    let channels: number;
    switch (colorType) {
      case ColorType.GREYSCALE:
        channels = 1;
        break;
      case ColorType.TRUECOLOUR:
        channels = 3;
        break;
      case ColorType.INDEXED_COLOUR:
        channels = 1;
        break;
      case ColorType.GREYSCALE_ALPHA:
        channels = 2;
        break;
      case ColorType.TRUECOLOUR_ALPHA:
        channels = 4;
        break;
      // Kept for exhaustiveness.
      // eslint-disable-next-line unicorn/no-useless-switch-case
      case ColorType.UNKNOWN:
      default:
        throw new PngFormatError(`Unknown color type: ${colorType}`);
    }
    this._png.channels = channels;

    this._compressionMethod = this.readUint8() as CompressionMethod;
    if (this._compressionMethod !== CompressionMethod.DEFLATE) {
      throw new PngFormatError(
        `Unsupported compression method: ${this._compressionMethod}`,
      );
    }

    this._filterMethod = this.readUint8() as FilterMethod;
    this._interlaceMethod = this.readUint8() as InterlaceMethod;
  }

  private decodeACTL(length: number, headerOffset: number): void {
    if (length !== APNG_ACTL_LENGTH) {
      throw new PngFormatError(
        `acTL chunk at byte offset ${headerOffset} must have length ${APNG_ACTL_LENGTH}, got ${length}`,
      );
    }
    this._numberOfFrames = this.readUint32();
    this._numberOfPlays = this.readUint32();
    if (this._numberOfFrames === 0) {
      throw new PngFormatError(
        `acTL chunk at byte offset ${headerOffset} declares zero frames`,
      );
    }
    this._isAnimated = true;
  }

  private decodeFCTL(length: number, headerOffset: number): void {
    if (length !== APNG_FCTL_LENGTH) {
      throw new PngFormatError(
        `fcTL chunk at byte offset ${headerOffset} must have length ${APNG_FCTL_LENGTH}, got ${length}`,
      );
    }
    const sequenceNumber = this.readUint32();
    this.checkSequenceNumber(sequenceNumber, 'fcTL', headerOffset);
    const width = this.readUint32();
    const height = this.readUint32();
    const xOffset = this.readUint32();
    const yOffset = this.readUint32();
    const delayNumber = this.readUint16();
    const delayDenominator = this.readUint16();
    const disposeOp = this.readUint8();
    const blendOp = this.readUint8();

    if (width === 0 || height === 0) {
      throw new PngFormatError(
        `fcTL chunk at byte offset ${headerOffset} declares zero frame dimensions (${width}x${height})`,
      );
    }
    if (
      this._hasIHDR &&
      (checkedAdd(xOffset, width) > this._png.width ||
        checkedAdd(yOffset, height) > this._png.height)
    ) {
      throw new PngFormatError(
        `fcTL chunk at byte offset ${headerOffset} places a ${width}x${height} frame at offset (${xOffset}, ${yOffset}), outside the ${this._png.width}x${this._png.height} image`,
      );
    }
    if (disposeOp > DisposeOpType.PREVIOUS) {
      throw new PngFormatError(
        `fcTL chunk at byte offset ${headerOffset} has unsupported disposeOp ${disposeOp}`,
      );
    }
    if (blendOp > BlendOpType.OVER) {
      throw new PngFormatError(
        `fcTL chunk at byte offset ${headerOffset} has unsupported blendOp ${blendOp}`,
      );
    }

    const image: ApngFrame = {
      sequenceNumber,
      width,
      height,
      xOffset,
      yOffset,
      delayNumber,
      delayDenominator,
      disposeOp,
      blendOp,
      data: new Uint8Array(0),
    };
    this._frames.push(image);
  }

  private checkSequenceNumber(
    sequenceNumber: number,
    type: string,
    headerOffset: number,
  ): void {
    if (sequenceNumber !== this._nextSequenceNumber) {
      throw new PngFormatError(
        `${type} chunk at byte offset ${headerOffset} has sequence number ${sequenceNumber}, expected ${this._nextSequenceNumber}`,
      );
    }
    this._nextSequenceNumber++;
  }

  // https://www.w3.org/TR/PNG/#11PLTE
  private decodePLTE(length: number, headerOffset: number): void {
    if (length % 3 !== 0) {
      throw new PngFormatError(
        `PLTE chunk at byte offset ${headerOffset}: field length must be a multiple of 3, got ${length}`,
      );
    }
    const entryCount = length / 3;
    if (entryCount === 0) {
      throw new PngFormatError(
        `PLTE chunk at byte offset ${headerOffset} must contain at least one palette entry`,
      );
    }
    if (entryCount > PALETTE_MAX_ENTRIES) {
      throw new PngFormatError(
        `PLTE chunk at byte offset ${headerOffset} contains ${entryCount} entries but a PNG palette holds at most ${PALETTE_MAX_ENTRIES}`,
      );
    }

    this._hasPalette = true;
    const palette: IndexedColors = [];
    this._palette = palette;
    for (let i = 0; i < entryCount; i++) {
      palette.push([this.readUint8(), this.readUint8(), this.readUint8()]);
    }
  }

  // https://www.w3.org/TR/PNG/#11IDAT
  private decodeIDAT(length: number): void {
    this._writingDataChunks = true;
    this.pushCompressedData(length, 0);
    this.skip(length);
  }

  private decodeFDAT(length: number, headerOffset: number): void {
    if (length < APNG_FDAT_MIN_LENGTH) {
      throw new PngFormatError(
        `fdAT chunk at byte offset ${headerOffset} must contain at least ${APNG_FDAT_MIN_LENGTH} bytes (sequence number), got ${length}`,
      );
    }
    this._writingDataChunks = true;
    const sequenceNumber = this.readUint32();
    this.checkSequenceNumber(sequenceNumber, 'fdAT', headerOffset);
    this.pushCompressedData(length, 4);
    this.skip(length - 4);
  }

  private pushCompressedData(length: number, prefixLength: number): void {
    const dataLength = length - prefixLength;
    const dataOffset = this.offset + this.byteOffset;
    try {
      this._inflator.push(
        new Uint8Array(this.buffer, dataOffset, dataLength),
        false,
      );
    } catch (error) {
      throw new PngFormatError('Error while decompressing the data:', {
        cause: error,
      });
    }
  }

  // https://www.w3.org/TR/PNG/#11tRNS
  private decodetRNS(length: number, headerOffset: number): void {
    switch (this._colorType) {
      case ColorType.GREYSCALE:
      case ColorType.TRUECOLOUR: {
        if (length % 2 !== 0) {
          throw new PngFormatError(
            `tRNS chunk at byte offset ${headerOffset}: length must be a multiple of 2, got ${length}`,
          );
        }
        const pixelCount = checkedMultiply(this._png.width, this._png.height);
        if (length / 2 > pixelCount) {
          throw new PngFormatError(
            `tRNS chunk at byte offset ${headerOffset} contains more alpha values than there are pixels (${length / 2} vs ${pixelCount})`,
          );
        }
        this._hasTransparency = true;
        this._transparency = new Uint16Array(length / 2);

        for (let i = 0; i < length / 2; i++) {
          this._transparency[i] = this.readUint16();
        }

        break;
      }
      case ColorType.INDEXED_COLOUR: {
        if (!this._hasPalette) {
          throw new PngFormatError(
            `tRNS chunk at byte offset ${headerOffset} appears before the PLTE chunk`,
          );
        }
        if (length > this._palette.length) {
          throw new PngFormatError(
            `tRNS chunk at byte offset ${headerOffset} contains more alpha values than there are palette colors (${length} vs ${this._palette.length})`,
          );
        }
        let i = 0;
        for (; i < length; i++) {
          const alpha = this.readByte();
          this._palette[i].push(alpha);
        }
        for (; i < this._palette.length; i++) {
          this._palette[i].push(255);
        }
        break;
      }
      // Kept for exhaustiveness.
      /* eslint-disable unicorn/no-useless-switch-case */
      case ColorType.UNKNOWN:
      case ColorType.GREYSCALE_ALPHA:
      case ColorType.TRUECOLOUR_ALPHA:
      default: {
        throw new PngFormatError(
          `tRNS chunk at byte offset ${headerOffset} is not supported for color type ${this._colorType}`,
        );
      }
      /* eslint-enable unicorn/no-useless-switch-case */
    }
  }

  // https://www.w3.org/TR/PNG/#11iCCP
  private decodeiCCP(length: number, headerOffset: number): void {
    const name = readKeyword(this, length, 'iCCP');
    // keyword + NULL separator + one compression-method byte
    const fixedOverhead = name.length + 2;
    if (length <= fixedOverhead) {
      throw new PngFormatError(
        `iCCP chunk at byte offset ${headerOffset} contains no compressed profile data`,
      );
    }
    const compressionMethod = this.readUint8();
    if (compressionMethod !== CompressionMethod.DEFLATE) {
      throw new PngFormatError(
        `Unsupported iCCP compression method: ${compressionMethod}`,
      );
    }
    const compressedProfile = this.readBytes(length - fixedOverhead);
    try {
      this._png.iccEmbeddedProfile = {
        name,
        profile: unzlibSync(compressedProfile),
      };
    } catch (error) {
      throw new PngFormatError(
        `iCCP chunk at byte offset ${headerOffset}: error while decompressing the embedded profile`,
        { cause: error },
      );
    }
  }

  // https://www.w3.org/TR/PNG/#11pHYs
  private decodepHYs(length: number, headerOffset: number): void {
    if (length !== PHYS_LENGTH) {
      throw new PngFormatError(
        `pHYs chunk at byte offset ${headerOffset} must have length ${PHYS_LENGTH}, got ${length}`,
      );
    }
    const ppuX = this.readUint32();
    const ppuY = this.readUint32();
    const unitSpecifier = this.readByte();
    this._png.resolution = {
      x: ppuX,
      y: ppuY,
      unit: unitSpecifier as ResolutionUnitSpecifier,
    };
  }

  private decodeApngImage() {
    this._apng.width = this._png.width;
    this._apng.height = this._png.height;
    this._apng.channels = this._png.channels;
    this._apng.depth = this._png.depth;
    this._apng.numberOfFrames = this._numberOfFrames;
    this._apng.numberOfPlays = this._numberOfPlays;
    this._apng.text = this._png.text;
    this._apng.resolution = this._png.resolution;
    if (this._isAnimated && this._frames.length < this._numberOfFrames) {
      throw new PngFormatError(
        `acTL declares ${this._numberOfFrames} frames but the file contains only ${this._frames.length} frame control (fcTL) chunk(s)`,
      );
    }
    for (let i = 0; i < this._numberOfFrames; i++) {
      const canvasBytes = expectedOutputSize({
        width: this._apng.width,
        height: this._apng.height,
        channels: this._apng.channels,
        depth: this._apng.depth,
        interlaceMethod: InterlaceMethod.NO_INTERLACE,
      });
      this._usedOutputBudget = checkedAdd(this._usedOutputBudget, canvasBytes);
      checkOutputBudget(this._usedOutputBudget, this._maxOutputSize);

      const newFrame: DecodedApngFrame = {
        sequenceNumber: this._frames[i].sequenceNumber,
        delayNumber: this._frames[i].delayNumber,
        delayDenominator: this._frames[i].delayDenominator,
        data: this.allocateCanvas(),
      };

      const frame = this._frames.at(i);

      if (frame) {
        this.validateFrameData(frame, i);
        frame.data = decodeInterlaceNull({
          data: frame.data as Uint8Array,
          width: frame.width,
          height: frame.height,
          channels: this._apng.channels,
          depth: this._apng.depth,
          maxOutputSize: this._maxOutputSize,
        });

        if (this._hasPalette) {
          this._apng.palette = this._palette;
        }
        if (this._hasTransparency) {
          this._apng.transparency = this._transparency;
        }
        if (
          i === 0 ||
          (frame.xOffset === 0 &&
            frame.yOffset === 0 &&
            frame.width === this._png.width &&
            frame.height === this._png.height)
        ) {
          newFrame.data = frame.data;
        } else {
          const prevFrame = this._apng.frames.at(i - 1);
          this.disposeFrame(frame, prevFrame as DecodedApngFrame, newFrame);
          this.addFrameDataToCanvas(newFrame, frame);
        }
        this._apng.frames.push(newFrame);
      }
    }
    return this._apng;
  }

  private allocateCanvas(): PngDataArray {
    const size = expectedOutputSize({
      width: this._apng.width,
      height: this._apng.height,
      channels: this._apng.channels,
      depth: this._apng.depth,
      interlaceMethod: InterlaceMethod.NO_INTERLACE,
    });
    if (this._apng.depth === 16) {
      return new Uint16Array(size / 2);
    }
    return new Uint8Array(size);
  }

  /**
   * Check that a frame's decompressed stream has exactly the size required by
   * its declared dimensions before any pixel processing happens.
   * @param frame - Frame whose data must be validated.
   * @param frameIndex - Zero-based frame index, used in error messages.
   */
  private validateFrameData(frame: ApngFrame, frameIndex: number): void {
    const expected = expectedRawDataSize({
      width: frame.width,
      height: frame.height,
      channels: this._apng.channels,
      depth: this._apng.depth,
      interlaceMethod: InterlaceMethod.NO_INTERLACE,
    });
    if (frame.data.length !== expected) {
      throw new PngFormatError(
        `Frame ${frameIndex} (sequence number ${frame.sequenceNumber}) decompressed to ${frame.data.length} bytes, expected ${expected} for a ${frame.width}x${frame.height} frame`,
      );
    }
  }

  private disposeFrame(
    frame: ApngFrame,
    prevFrame: DecodedApngFrame,
    imageFrame: DecodedApngFrame,
  ): void {
    switch (frame.disposeOp) {
      case DisposeOpType.NONE:
        break;
      case DisposeOpType.BACKGROUND:
        for (let row = 0; row < this._png.height; row++) {
          for (let col = 0; col < this._png.width; col++) {
            const index = (row * frame.width + col) * this._png.channels;
            for (let channel = 0; channel < this._png.channels; channel++) {
              imageFrame.data[index + channel] = 0;
            }
          }
        }
        break;
      case DisposeOpType.PREVIOUS:
        imageFrame.data.set(prevFrame.data);
        break;
      default:
        throw new PngFormatError(`Unknown disposeOp ${frame.disposeOp}`);
    }
  }
  private addFrameDataToCanvas(
    imageFrame: DecodedApngFrame,
    frame: ApngFrame,
  ): void {
    const maxValue = 1 << this._png.depth;
    const calculatePixelIndices = (row: number, col: number) => {
      const index =
        ((row + frame.yOffset) * this._png.width + frame.xOffset + col) *
        this._png.channels;
      const frameIndex = (row * frame.width + col) * this._png.channels;
      return { index, frameIndex };
    };
    switch (frame.blendOp) {
      case BlendOpType.SOURCE:
        for (let row = 0; row < frame.height; row++) {
          for (let col = 0; col < frame.width; col++) {
            const { index, frameIndex } = calculatePixelIndices(row, col);
            for (let channel = 0; channel < this._png.channels; channel++) {
              imageFrame.data[index + channel] =
                frame.data[frameIndex + channel];
            }
          }
        }
        break;
      // https://www.w3.org/TR/png-3/#13Alpha-channel-processing
      case BlendOpType.OVER:
        for (let row = 0; row < frame.height; row++) {
          for (let col = 0; col < frame.width; col++) {
            const { index, frameIndex } = calculatePixelIndices(row, col);
            for (let channel = 0; channel < this._png.channels; channel++) {
              const sourceAlpha =
                frame.data[frameIndex + this._png.channels - 1] / maxValue;
              const foregroundValue =
                channel % (this._png.channels - 1) === 0
                  ? 1
                  : frame.data[frameIndex + channel];
              const value = Math.floor(
                sourceAlpha * foregroundValue +
                  (1 - sourceAlpha) * imageFrame.data[index + channel],
              );
              imageFrame.data[index + channel] += value;
            }
          }
        }
        break;
      default:
        throw new PngFormatError(`Unknown blendOp ${frame.blendOp}`);
    }
  }
  private decodeImage(): void {
    const data = this._inflatorResult;

    if (this._filterMethod !== FilterMethod.ADAPTIVE) {
      throw new PngFormatError(
        `Filter method ${this._filterMethod} not supported`,
      );
    }

    if (this._interlaceMethod === InterlaceMethod.NO_INTERLACE) {
      this._png.data = decodeInterlaceNull({
        data,
        width: this._png.width,
        height: this._png.height,
        channels: this._png.channels,
        depth: this._png.depth,
        maxOutputSize: this._maxOutputSize,
      });
    } else if (this._interlaceMethod === InterlaceMethod.ADAM7) {
      this._png.data = decodeInterlaceAdam7({
        data,
        width: this._png.width,
        height: this._png.height,
        channels: this._png.channels,
        depth: this._png.depth,
        maxOutputSize: this._maxOutputSize,
      });
    } else {
      throw new PngFormatError(
        `Interlace method ${this._interlaceMethod} not supported`,
      );
    }

    if (this._hasPalette) {
      this._png.palette = this._palette;
    }
    if (this._hasTransparency) {
      this._png.transparency = this._transparency;
    }
  }

  private pushDataToFrame() {
    // Finalize the current stream.
    this.finalizeInflator();

    const result = this._inflatorResult;
    const lastFrame = this._frames.at(-1);
    if (lastFrame) {
      lastFrame.data = result;
    } else {
      this._frames.push({
        sequenceNumber: 0,
        width: this._png.width,
        height: this._png.height,
        xOffset: 0,
        yOffset: 0,
        delayNumber: 0,
        delayDenominator: 0,
        disposeOp: DisposeOpType.NONE,
        blendOp: BlendOpType.SOURCE,
        data: result,
      });
    }

    // Create new inflator for next frame
    this._inflator = new Inflator((chunk, final) => {
      this._chunks.push(chunk);
      if (final) {
        this._inflatorResult = this._assembleInflatedChunks();
      }
    });
    this._chunks = [];
    this._writingDataChunks = false;
  }
}

function checkBitDepth(value: number): BitDepth {
  if (
    value !== 1 &&
    value !== 2 &&
    value !== 4 &&
    value !== 8 &&
    value !== 16
  ) {
    throw new PngFormatError(`invalid bit depth: ${value}`);
  }
  return value;
}
