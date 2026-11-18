<h3 align="center">
  <a href="https://www.zakodium.com">
    <img src="https://www.zakodium.com/brand/zakodium-logo-white.svg" width="50" alt="Zakodium logo" />
  </a>
  <p>
    Maintained by <a href="https://www.zakodium.com">Zakodium</a>
  </p>
</h3>

# fast-png

[![NPM version](https://img.shields.io/npm/v/fast-png.svg)](https://www.npmjs.com/package/fast-png)
[![npm download](https://img.shields.io/npm/dm/fast-png.svg)](https://www.npmjs.com/package/fast-png)
[![test coverage](https://img.shields.io/codecov/c/github/image-js/fast-png.svg)](https://codecov.io/gh/image-js/fast-png)
[![license](https://img.shields.io/npm/l/fast-png.svg)](https://github.com/image-js/fast-png/blob/main/LICENSE)

PNG image decoder and encoder written entirely in JavaScript.

## Installation

```console
npm install fast-png
```

## API

### [Complete API documentation](https://image-js.github.io/fast-png/)

### `decode(png[, options])`

#### Arguments

- `png` - A TypedArray or Buffer that contains the PNG data.
- `options` - An object of options

#### Options

- `checkCrc` - If set to `true`, the CRC will be checked for each chunk and an error will be thrown in case it's wrong (default: false).
- `maxOutputSize` - Maximum number of bytes the decoder is allowed to produce, including the decompressed scanline data and the final pixel output. For animated images the output of every frame is counted cumulatively. Sizes are checked before any allocation, so malformed files with huge declared dimensions or frame counts are rejected instead of exhausting memory (default: `Infinity`, no additional limit).

Malformed files (truncated chunks, invalid lengths, bad text or palette data, oversized or corrupted decompressed streams, invalid APNG frame declarations, ...) throw a `PngFormatError` whose message names the offending chunk and its byte offset. The structural checks run before any chunk content is read and are independent of `checkCrc`: a truncated file is rejected even when CRC checking is disabled, and a wrong CRC is only reported when `checkCrc` is enabled.

### `encode(image)`

#### Arguments

- `png` - An object representing the image. You can pass an ImageData from the Canvas API or an object with the following properties:
  - `width` - The width of the image
  - `height` - The height of the image
  - `data` - An array or TypedArray with the image data
  - `depth` - A number indicating the color depth (only 8 and 16 are supported now). Default: `8`.
  - `channels` - Number of channels, including alpha (1, 2, 3 and 4 are supported). Default: `4`.
  - `text` - An object with key-value pairs representing `tEXt` chunks. The keys must have less than 80 characters.
    The keys and values must have only characters in the latin1 charset (maximum code point of 255).
    Default: `undefined`.

### `hasPngSignature(array)`

Returns whether the array starts with the PNG signature (magic bytes).

## PNG standard

Spec can be found at: https://www.w3.org/TR/PNG/

## License

[MIT](./LICENSE)
