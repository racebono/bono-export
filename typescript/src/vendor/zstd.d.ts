/** Pinned upstream Emscripten module; copied unchanged by scripts/assets.mjs. */
export const Module: {
  instantiateWasm?: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => WebAssembly.Exports;
  init(): unknown;
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _ZSTD_createDCtx(): number;
  _ZSTD_freeDCtx(context: number): number;
  _ZSTD_decompress_usingDict(context: number, dest: number, capacity: number,
    source: number, sourceSize: number, dictionary: number, dictionarySize: number): number;
  _ZSTD_isError(code: number): number;
};
