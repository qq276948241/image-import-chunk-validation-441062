import { PngFormatError } from './error.ts';

/**
 * Multiply non-negative integers while rejecting results that exceed
 * Number.MAX_SAFE_INTEGER. All image dimensions and buffer sizes are
 * validated with these helpers before any allocation happens.
 * @param a - First factor.
 * @param b - Second factor.
 * @returns The checked product.
 */
export function checkedMultiply(a: number, b: number): number {
  const result = a * b;
  if (!Number.isSafeInteger(result)) {
    throw new PngFormatError(
      `Integer overflow while computing size: ${a} * ${b}`,
    );
  }
  return result;
}

/**
 * Add two non-negative integers while rejecting results that exceed
 * Number.MAX_SAFE_INTEGER.
 * @param a - First operand.
 * @param b - Second operand.
 * @returns The checked sum.
 */
export function checkedAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new PngFormatError(
      `Integer overflow while computing size: ${a} + ${b}`,
    );
  }
  return result;
}

/**
 * Validate that the given size is an integer that does not exceed the
 * configured output budget.
 * @param size - Required output size in bytes.
 * @param maxOutputSize - Configured maximum output size in bytes.
 */
export function checkOutputBudget(size: number, maxOutputSize: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new PngFormatError(`Invalid computed output size: ${size}`);
  }
  if (size > maxOutputSize) {
    throw new PngFormatError(
      `Output size ${size} bytes exceeds the configured limit of ${maxOutputSize} bytes`,
    );
  }
}
