/**
 * Error thrown when a PNG file does not conform to the structure required by
 * the decoder. Every malformed input must surface as this error so that native
 * out-of-bounds errors from the underlying data view never leak to callers.
 */
export class PngFormatError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PngFormatError';
  }
}
