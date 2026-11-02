import * as S from 'wa-sqlite';

export interface ReadableFile {
  readonly size: number;
  read(target: Uint8Array, offset: number): Promise<number>;
}

/** A single immutable database; all journals, sidecars and writes are refused. */
export class ReadOnlyVFS {
  readonly name = 'bono-readonly';
  readonly mxPathName = 128;
  error: Error | undefined;
  constructor(private file: ReadableFile) {}

  // wa-sqlite replaces this method when registered with its Asyncify build.
  handleAsync(_operation: () => Promise<number>): number { throw new Error('Async VFS was not registered'); }
  xOpen(name: string | null, _id: number, flags: number, out: DataView) {
    if (name !== '/database' || !(flags & S.SQLITE_OPEN_MAIN_DB) || flags & S.SQLITE_OPEN_READWRITE) return S.SQLITE_CANTOPEN;
    out.setInt32(0, S.SQLITE_OPEN_READONLY, true);
    return S.SQLITE_OK;
  }
  xClose(_id: number) { return S.SQLITE_OK; }
  xRead(_id: number, target: Uint8Array, offset: number): number {
    return this.handleAsync(async () => {
      try {
        const count = await this.file.read(target, offset);
        if (count === target.length) return S.SQLITE_OK;
        target.fill(0, count);
        return S.SQLITE_IOERR_SHORT_READ;
      } catch (error) {
        // Only our local filesystem errors reach here, never raw fetch errors.
        this.error = error instanceof Error ? error : new Error('Database read failed');
        return S.SQLITE_IOERR_READ;
      }
    });
  }
  xFileSize(_id: number, out: DataView) { out.setBigInt64(0, BigInt(this.file.size), true); return S.SQLITE_OK; }
  xAccess(_name: string, _flags: number, out: DataView) { out.setInt32(0, 0, true); return S.SQLITE_OK; }
  xWrite() { return S.SQLITE_READONLY; }
  xTruncate() { return S.SQLITE_READONLY; }
  xDelete() { return S.SQLITE_READONLY; }
  xSync() { return S.SQLITE_OK; }
  xLock() { return S.SQLITE_OK; }
  xUnlock() { return S.SQLITE_OK; }
  xCheckReservedLock(_id: number, out: DataView) { out.setInt32(0, 0, true); return S.SQLITE_OK; }
  xFileControl() { return S.SQLITE_NOTFOUND; }
  xSectorSize() { return 65536; }
  xDeviceCharacteristics() { return S.SQLITE_IOCAP_IMMUTABLE; }
}
