# Native helper source

This directory contains the macOS helper from DeepSeek Harness commit `42da1c2868`, including the local cursor prototype. The DeepSeek and Cua Driver licenses are retained here. It requires macOS 14 or later and Swift 6. The plugin selects the native provider by default on macOS; its preview uses authorized display-only captures; the integrated GUI flow has not been verified. The optional `perse-cua/native` entry lets a host mount the rc.2 provider under its own loader id.

From the workspace root, build one architecture into an explicit staging directory:

```sh
npm run build:native -- --arch arm64 --output /absolute/staging/path
```

Use `x64` for Intel. The builder compiles in temporary storage, signs and verifies the helper, checks its architecture and minimum macOS version, and records its digest. Ad-hoc signing is the default; it does not provide Developer ID or notarization. Supply `--sign-identity` and `--require-developer-id` when preparing a Developer ID signed release. A successful build does not verify GUI behavior, consent, screenshots or a host integration.

Packing checks both helper digests and their source digest on every platform. macOS also checks the executable architecture and signature; a package prepared elsewhere requires those checks on macOS before release.
