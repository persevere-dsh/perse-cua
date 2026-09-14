# perse-cua

[![ci](https://github.com/persevere-dsh/perse-cua/actions/workflows/ci.yml/badge.svg)](https://github.com/persevere-dsh/perse-cua/actions/workflows/ci.yml)

English | [中文](README.zh.md)

`perse` = persevere

Front [cua-driver](https://github.com/trycua/cua)'s desktop-automation tools to a DSH model
without paying for the parts a session never uses.

**Part of Persevere with DSH**

-----

## What it solves

cua-driver 0.28.1 advertises **56 tools**. Every one of them is attached to *every*
model request whether or not the task touches a GUI. Measured on the released driver:

| | tools | model-facing schema | ≈ tokens per request |
| --- | --- | --- | --- |
| plain `@deepseek-ai/dsh-mcp-client` row | 56 | 95.1 KB | ~24,300 |
| through `perse-cua` | 27 | 39.7 KB | ~10,200 |

And once a task *is* driving an app, a raw window snapshot is mostly menu bar: on a
230×408 Calculator window the menu subtree was 145 of 146 elements and **88% of the
rendered bytes**. It can never be an automation target — menu items are reached with
`invoke_menu` by path — so it is pure grounding noise.

## What it does

1. **Curates the surface.** Keeps the desktop-automation loop — discover, observe, act,
   verify, transfer, diagnose — and drops browser CDP tooling, trajectory recording,
   cursor cosmetics, session lifecycle, and the self-update probe. Widen it from config.
2. **Condenses descriptions** to their first sentence. The full operating procedure is
   not lost: it already ships as the `cua-driver` skill, which the model loads on demand.
   Parameter schemas are passed through untouched, so every tool still validates.
3. **Strips the accessibility menu bar** out of rendered trees, leaving the window block
   byte-identical — including the original element numbering, because an `element_token`
   must keep resolving against the snapshot the driver cached.

## Use this plugin

Add one row to a profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: perse-cua
      name: perse-cua
      config:
        command: /Users/you/.local/bin/cua-driver
        serverName: cua
```

Then install it and **remove any plain `dsh-mcp-client` row pointed at the same driver** —
this plugin owns that MCP connection itself:

```sh
npm pack --workspace perse-cua
dsh plugin --profile web add ./perse-cua-0.1.0.tgz
```

### Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | `cua-driver` | Driver executable |
| `args` | `["mcp"]` | Arguments for the driver |
| `env` | — | Extra environment for the child process |
| `serverName` | `cua` | Namespace; tools appear as `mcp__<serverName>__<tool>` |
| `allow` | see `DEFAULT_ALLOW` | Bare tool names to keep |
| `deny` | `[]` | Bare tool names to drop; wins over `allow` |
| `condenseDescriptions` | `true` | First-sentence descriptions |
| `trimMenuTrees` | `true` | Remove `AXMenu*` subtrees from rendered trees |
| `requestTimeoutMs` | `120000` | Per-call timeout |
| `startupTimeoutMs` | `30000` | Spawn + handshake budget |

Both `allow` and `deny` accept bare (`click`) or namespaced (`mcp__cua__click`) names.
An `allow` entry that matches no advertised tool is reported in the log rather than
silently ignored, so a driver upgrade that renames a tool is visible.

## What it deliberately does not do

- **No Typert artifacts, and therefore no `codegen` script.** `perse-cua` registers no
  Cordis service, emits no event, and exposes no `@Remote` method, so the Typert
  generator discovers no face for it — it exits with `discovered: []`. The manifest
  declares no `./typert` or `./remote` export rather than shipping dangling paths.
  `dsh-zai-search-tools`, the working host-only plugin in the maintainer's profile,
  has the same shape.
- **No browser CDP tools.** `browser_*` and the legacy `page` tool are curated out by
  default. Re-add them through `allow` if a task needs them.
- **No reconnect.** A driver process that dies is reported as a failed call; the next
  call fails too until the harness reloads the plugin. cua-driver is a local process,
  and silent respawn was judged worse than a visible failure.

## Platform notes

- macOS needs Accessibility **and** Screen Recording. Run `cua-driver permissions grant`
  once: the driver launches `CuaDriver.app` through LaunchServices so the TCC grant
  attaches to `com.trycua.driver`, not to the harness.
- Actions run in the background by default and do not steal the user's focus.
- A driver that cannot resolve a window's accessibility surface returns an **empty tree
  with `degraded_reason: ax_window_unresolved`** instead of a tree from the wrong
  surface. If you see that, the app's window changed underneath the driver; re-launch
  the app and snapshot again.

## Development

```sh
npm ci
npm run typecheck
npm run build      # tsc -> lib/types, then tsdown -> lib/index.js
npm test           # build + node --test test/*.test.mjs
```

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Xilong Liu.
