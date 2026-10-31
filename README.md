# bono-export

Exports a SQLite database into one small, read-only copy, its pages compressed with
[sqlite_zstd_vfs](https://github.com/mlin/sqlite_zstd_vfs). The VFS is built into the program from
`vendor` (see [`vendor/README.md`](vendor/README.md)) rather than loaded as an extension.

Made for the telemetry recordings of [bono](https://github.com/racebono/bono).

## TypeScript / Node.js

The [TypeScript library](typescript/README.md) opens exports over HTTP(S) with
`await openUrl(url)` and runs read-only SQL using SQLite and zstd WebAssembly.
It fetches only the portions queries read and supports Node.js 22+ without native addons.

## Building

Needs a C++14 compiler. The benchmark also builds `bono-sim` from bono, whose bindings need
libclang (`LIBCLANG_PATH` on Windows).

```sh
cargo test
```

## Benchmark

How big each step of an export leaves a recording, how long it takes, and how fast bono's queries
read it afterwards:

```sh
cargo bench
```

See [`benches/export.rs`](benches/export.rs) for its options.

## License

MIT, see [`LICENSE`](LICENSE). The vendored sources keep their own licenses, listed in
[`vendor/README.md`](vendor/README.md).
