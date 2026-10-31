# Native helper source

This directory contains the macOS helper from DeepSeek Harness commit `42da1c2868`, including the local cursor prototype. The DeepSeek and Cua Driver licenses are retained here. It requires macOS 14 or later and Swift 6. The plugin selects the native provider by default on macOS; its preview uses authorized display-only captures; the integrated GUI flow has not been verified. The optional `perse-cua/native` entry lets a host mount the rc.2 provider under its own loader id.

From the workspace root, build one architecture into an explicit staging directory:

```sh
npm run build:native -- --arch arm64 --output /absolute/staging/path
```

Use `x64` for Intel. The builder compiles in temporary storage, signs and verifies the helper, checks its architecture and minimum macOS version, and records its digest. Ad-hoc signing is the default; it does not provide Developer ID or notarization. Supply `--sign-identity` and `--require-developer-id` when preparing a Developer ID signed release. A successful build does not verify GUI behavior, consent, screenshots or a host integration.

Packing checks both helper digests and their source digest on every platform. macOS also checks the executable architecture and signature; a package prepared elsewhere requires those checks on macOS before release.

Hover uses advertised AX alternate UI. Without it, the helper returns `UNSUPPORTED` and does not send pointer input or activate the app. A successful AX dispatch still requires observing the app to confirm the intended effect.

The opt-in isolated hover fixture runs without DSH: `python3 packages/perse-cua/native/tests/hover-fixture/run.py --helper /absolute/path/to/dsh-cua-native`. `--prepare-only` builds and signs its fixture and stages the helper without starting either process. By default the helper and fixture use stable paths under `~/Library/Caches/perse-cua-hover-fixture`; `--test-root /absolute/private/path` selects another dedicated root. The root must be an empty or previously initialized private directory, and one run owns it at a time. Unchanged helper bytes and fixture source reuse the staged executables; changing them can change macOS authorization identity and require new approval. A unique temporary runtime directory isolates every helper socket from DSH. macOS may attribute permissions to the helper, host or responsible application; stable paths do not guarantee grants survive signature changes or OS policy. No TCC database is modified.

The fixture checks actual AX alternate reveal, descendant hover and click, restore, and rejection of tracking-only hover. A real run refuses to start unless explicitly passed `--allow-desktop-change`: even a nonactivating regular app can change the Dock, a background window can be visible in uncovered screen areas, and click feedback can appear above other apps. After ordering its window behind normal windows, the fixture checks WindowServer ordering, the foreground app and the pointer; it exits if it cannot verify those conditions. Those checks cannot prevent another app or user input from changing the desktop concurrently. The run samples the pointer and foreground app every 20 ms, so it can miss brief changes. It requires an unlocked idle desktop, explicit authorization, and Accessibility permission for the responsible helper. Its observations do not establish that the cursor panel is visible on screen; compilation and unit tests alone do not verify GUI behavior.
