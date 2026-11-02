export interface Decoder {
  decode(data: Uint8Array, dictionary?: Uint8Array): Uint8Array;
  close(): void;
}

export function validateFrame(data: Uint8Array): void {
  // The dependency allocates the advertised frame size. Validate it first,
  // so a corrupt page cannot request a huge WASM allocation.
  if (data.length < 5 || new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 0xfd2fb528) {
    throw new Error('Invalid zstd page frame');
  }
  const descriptor = data[4]!;
  if (descriptor & 0x18) throw new Error('Invalid zstd frame descriptor');
  const single = !!(descriptor & 0x20), flag = descriptor >>> 6;
  const dictLength = [0, 1, 2, 4][descriptor & 3]!;
  const offset = 5 + (single ? 0 : 1) + dictLength;
  const bytes = flag ? 1 << flag : single ? 1 : 0;
  if (data.length < offset + bytes) throw new Error('Truncated zstd frame header');
  if (bytes) {
    let size = 0n;
    for (let i = bytes - 1; i >= 0; i--) size = (size << 8n) | BigInt(data[offset + i]!);
    if (bytes === 2) size += 256n;
    if (size !== 8192n) throw new Error('Invalid decoded page size');
  }
}
