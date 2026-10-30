# Native provider adaptation

`dsh-cua.js` and `dsh-cua-macos.js` are derived from the published DeepSeek Harness 0.2.1-rc.2 packages under the adjacent MIT license. The local adaptation exposes a per-Agent capture callback that uses the existing native connection and application access check. A capture is cancelled and settled before a new model operation, is included in provider cleanup, and marks captures display-only so neither the Host nor the native helper changes the model's screenshot-coordinate state. Loader volatile updates are observed on the owning entry so revoked grants cancel access and clear previews. The PTC bridge resolves through the installed `@deepseek-ai/dsh-cua/bridge` package export.

The bundled copies are tied to this exact provider version. Update their local adaptation and tests together when changing the provider dependency.
