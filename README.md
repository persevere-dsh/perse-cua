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
| through `perse-cua` (default) | 49 | 60.0 KB | ~15,400 (**−37%**) |

And once a task *is* driving an app, a raw window snapshot is mostly menu bar: on a
230×408 Calculator window the menu subtree was 145 of 146 elements and **88% of the
rendered bytes**. It can never be an automation target — menu items are reached with
`invoke_menu` by path — so it is pure grounding noise.

## What it does

1. **Condenses descriptions** to their first sentence — this is where the default saving
   comes from. The full operating procedure is not lost: it already ships as the
   `cua-driver` skill, which the model loads on demand. Parameter schemas pass through
   untouched, so every tool still validates.
2. **Denies only proven waste.** The default `deny` list is seven tools that cannot
   change a task outcome: four `*_agent_cursor_*` overlay-artwork tools, the
   `check_for_update` probe, and two deprecated compatibility shims
   (`escalate_session`, `get_session_state`). Everything else the driver advertises
   reaches the model.
3. **Strips the accessibility menu bar** out of rendered trees, leaving the window block
   byte-identical — including the original element numbering, because an `element_token`
   must keep resolving against the snapshot the driver cached.

### Why the default is this conservative

An earlier revision curated against a hand-written "desktop-automation loop" allow list
and reported a 58% saving. Most of that extra 21 points was **capability removal, not
waste removal** — it dropped web automation, trajectory replay, session lifecycle, and
the real pointer, then presented the total as an efficiency win. Measured with the
corrected split:

| policy | tools | schema | ≈ tokens | capability |
| --- | --- | --- | --- | --- |
| description condensation alone | 56 | 62.7 KB | ~16,000 | complete |
| **default: condensation + deny waste** | **49** | **60.0 KB** | **~15,400** | **complete** |
| condensation + `MINIMAL_ALLOW` | 27 | 39.7 KB | ~10,200 | desktop only |

The condensed-everything row is the honest upper bound on what is free. An allow list is
a **capability ceiling**: a tool missing from it is invisible to the model rather than
merely unused, and the model cannot ask for what it cannot see.

If request size matters more than reach, opt in to the aggressive cut explicitly:

```yaml
- id: perse-cua
  config:
    allow: !!js (await import('perse-cua')).MINIMAL_ALLOW
```

## Use this plugin

`perse-cua` ships `dsh.bundle.patch`, so installing it already registers its loader row.
Add a **config override** — not a second `insert`, which would collide on the loader id
(preflight rule R-07):

```yaml
- id: perse-cua
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
| `allow` | omitted | Bare tool names to keep. Omit to keep every advertised tool except `deny`. Pass `MINIMAL_ALLOW` for the token-tight desktop-only cut |
| `deny` | `WASTE_ONLY_TOOLS` | Bare tool names to drop; wins over `allow` |
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
- **No reconnect.** A driver process that dies is reported as a failed call; the next
  call fails too until the harness reloads the plugin. cua-driver is a local process,
  and silent respawn was judged worse than a visible failure.

## Platform notes

- macOS needs Accessibility **and** Screen Recording. Run `cua-driver permissions grant`
  once: the driver launches `CuaDriver.app` through LaunchServices so the TCC grant
  attaches to `com.trycua.driver`, not to the harness.
- Actions run in the background by default and do not steal the user's focus.
  `move_cursor` in its default window scope paints the agent overlay only; moving the
  real OS pointer needs `scope: "desktop"`, which is a foreground takeover.
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
