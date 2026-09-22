#!/bin/sh
set -eu
# Run from the project root. Toolchain installation happens on the Mac only.
if ! command -v cargo-zigbuild >/dev/null 2>&1; then
    uv tool install 'cargo-zigbuild==0.23.4'
fi
# uv's ziglang package exposes python-zig next to cargo-zigbuild.
PATH="$(uv tool dir)/cargo-zigbuild/bin:$PATH"
export PATH
rustup target add aarch64-unknown-linux-musl
cargo zigbuild --locked --release --target aarch64-unknown-linux-musl
