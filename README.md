# perse-cua

English | [中文](README.zh.md)

`perse` = persevere

Desktop automation for DSH: macOS defaults to the native `cua` tool; other platforms default to [cua-driver](https://github.com/trycua/cua) MCP.

**Part of Persevere with DSH**

-----

On macOS 14 or later the default backend is the experimental DSH native provider. The model uses the registered `cua` tool and its per-application authorization flow directly; it supports background AX operations and screenshots, but not typed browser tabs. For those, explicitly configure the MCP backend and follow its authorization; never switch providers to bypass denied or revoked access. It asks for application consent and requires the host to provide the DSH 0.2.1-rc.2 services. Its preview captures authorized windows after observed operations without changing model screenshot coordinates. The combined native GUI, consent and cursor experience has not been verified. The driver measurements and behavior below apply to `backend: mcp`.

Existing macOS configurations with MCP-specific options such as `command`, `args`, `allow`, or `indicator` must add `backend: mcp`; without it startup reports an error instead of silently selecting the external driver. Profiles with an existing native provider can use `presenterOnly: true` to expose the view service, but automatic native previews require this plugin to own the provider and its authorization lifecycle.

## What the MCP backend solves

cua-driver 0.28.1 advertises **56 tools**. Every one of them is attached to *every*
model request whether or not the task touches a GUI. Measured on the released driver:

| | tools | model-facing schema | ≈ tokens per request |
| --- | --- | --- | --- |
| plain `@deepseek-ai/dsh-mcp-client` row | 56 | 95.1 KB | ~24,300 |
| through `perse-cua` (default) | 53 | 61.7 KB | ~15,800 (**−35%**) |

And once a task *is* driving an app, a raw window snapshot is mostly menu bar: on a
230×408 Calculator window the menu subtree was 145 of 146 elements and **88% of the
rendered bytes**. It can never be an automation target — menu items are reached with
`invoke_menu` by path — so it is pure grounding noise.

## What the MCP backend does

1. **Condenses descriptions** to their first sentence — this is where the default saving
   comes from. Parameter schemas pass through untouched, so every tool still validates.
2. **Denies only proven waste.** With `bestExperience` on (the default) the default
   `deny` list is the three tools that cannot change a task outcome: the
   `check_for_update` probe and the two deprecated compatibility shims
   (`escalate_session`, `get_session_state`). Set `bestExperience: false` to also deny
   the four `*_agent_cursor_*` tools, restoring the old surface. Everything else the
   driver advertises reaches the model.
3. **Strips the accessibility menu bar** out of rendered trees, leaving the window block
   byte-identical — including the original element numbering, because an `element_token`
   must keep resolving against the snapshot the driver cached.
4. **Turns on the macOS MCP best experience** by default: at boot the plugin opens a named
   driver session (default label `perse-cua`) and shows its **agent cursor** — the
   Codex-style effect where you watch a visible cursor do the work in a background
   window while your own mouse, keyboard focus, and frontmost app stay untouched.
   The four `*_agent_cursor_*` tools stay in front of the model so it can re-theme,
   re-time, or hide the cursor mid-task. A driver that rejects the call degrades to
   "cursor hidden"; the boot never breaks.

### Why the default is this conservative

An earlier revision curated against a hand-written "desktop-automation loop" allow list
and reported a 58% saving. Most of that extra 21 points was **capability removal, not
waste removal** — it dropped web automation, trajectory replay, session lifecycle, and
the real pointer, then presented the total as an efficiency win. Measured with the
corrected split:

| policy | tools | schema | ≈ tokens | capability |
| --- | --- | --- | --- | --- |
| description condensation alone | 56 | 62.7 KB | ~16,000 | complete |
| **default: condensation + deny waste** | **53** | **61.7 KB** | **~15,800** | **complete** |
| condensation + `MINIMAL_ALLOW` (cursor unioned in) | 31 | ~41.5 KB | ~10,700 | desktop only |

The condensed-everything row is the honest upper bound on what is free. An allow list is
a **capability ceiling**: a tool missing from it is invisible to the model rather than
merely unused, and the model cannot ask for what it cannot see.

If request size matters more than reach, opt in to the aggressive cut explicitly:

```yaml
- id: perse-cua
  config:
    backend: mcp
    allow: !!js (await import('perse-cua')).MINIMAL_ALLOW
```

## Use this plugin

`perse-cua` ships `dsh.bundle.patch`, so installing it already registers its loader row.
The macOS default needs no backend override. To select the external MCP driver, add a **config override** — not a second `insert`, which would collide on the loader id
(preflight rule R-07):

```yaml
- id: perse-cua
  config:
    backend: mcp
    command: /Users/you/.local/bin/cua-driver
    serverName: cua
```

Then install it and **remove any plain `dsh-mcp-client` row pointed at the same driver** —
this plugin owns that MCP connection itself:

```sh
npm pack --workspace perse-cua
dsh plugin --profile web add ./perse-cua-0.3.1-rc.1.tgz
```

### Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `presenterOnly` | `false` | Provide only the preview service; do not observe native tool results or start a driver |
| `backend` | `native` on macOS; `mcp` elsewhere | Select `native` or `mcp`; native requires macOS 14 or later |
| `command` | `cua-driver` | Driver executable |
| `args` | `["mcp"]` | Arguments for the driver |
| `env` | — | Extra environment for the child process |
| `serverName` | `cua` | Namespace; tools appear as `mcp__<serverName>__<tool>` |
| `allow` | omitted | Bare tool names to keep. Omit to keep every advertised tool except `deny`. Pass `MINIMAL_ALLOW` for the token-tight desktop-only cut (cursor tools are unioned back in under `bestExperience`) |
| `deny` | 3 shims | Bare tool names to drop; wins over `allow`. `bestExperience: false` restores the four cursor tools to the deny set |
| `bestExperience` | `true` | Keep the agent-cursor tools and show the visible cursor at boot (implicit transport session) |
| `bestExperienceSession` | omitted | Driver session label that owns the best-experience cursor |
| `indicator` | follows `bestExperience` | Show the macOS menu-bar indicator; set `false` to disable it |
| `indicatorStateFile` | `~/Library/Application Support/perse-cua/indicator.json` | State file shared with the indicator helper |
| `condenseDescriptions` | `true` | First-sentence descriptions |
| `trimMenuTrees` | `true` | Remove `AXMenu*` subtrees from rendered trees |
| `requestTimeoutMs` | `120000` | Per-call timeout |
| `startupTimeoutMs` | `30000` | Spawn + handshake budget |

Both `allow` and `deny` accept bare (`click`) or namespaced (`mcp__cua__click`) names.
An `allow` entry that matches no advertised tool is reported in the log rather than
silently ignored, so a driver upgrade that renames a tool is visible.

## Driving previews

Native previews refresh after observed operations using the same application authorization. A failed call clears the image and triggers a fresh capture; only a failed preview capture marks the screenshot unavailable. Previews are scoped to the selected Session and the Remote gateway authorizes access to that Session.

With the MCP backend, the plugin streams separate window images to its browser client. It identifies targets from window reads and window-targeted actions, and preserves the action session when requesting a preview. Select a card to enlarge it, switch windows, or close a card. The image time is the response receipt time. A brief click indicator appears only when the driver accepts a pixel click bound to the same window, session, and captured image; it is an action marker, while the actual agent cursor is rendered by the driver on the target window and may not appear in window screenshots. Actions without a verified pixel position show no marker. The plugin checks the target window list before publishing a preview; an off-screen or absent window keeps its last image and time and is marked unavailable. If capture or enumeration fails, the card marks the screenshot unavailable; dismiss it when no longer needed. The client clears stale cards and retries an unexpectedly ended preview stream. A preview requires an Agent owner and the host Remote gateway and client slots.

The exported `PreviewService` can also receive `put` and `remove` calls from a different provider. That provider owns authorization, cursor behavior, and removing its windows.

The `perse-cua/presenter` entry registers only the preview service and never starts or configures the driver. Its provider owns authorization and cursor behavior. The action-position marker identifies the submitted point on the matching captured image; a driver may dispatch that action using accessibility rather than a pointer press.

## What it deliberately does not do

- **No reconnect.** A driver process that dies is reported as a failed call; the next
  call fails too until the harness reloads the plugin. cua-driver is a local process,
  and silent respawn was judged worse than a visible failure.

## Platform notes

- The MCP backend on macOS needs Accessibility **and** Screen Recording. Run `cua-driver permissions grant`
  once: the driver launches `CuaDriver.app` through LaunchServices so the TCC grant
  attaches to `com.trycua.driver`, not to the harness.
- Actions run in the background by default and do not steal the user's focus.
  `move_cursor` in its default window scope paints the agent overlay only; moving the
  real OS pointer needs `scope: "desktop"`, which is a foreground takeover.
- The menu-bar indicator starts with the plugin and exits after 60 seconds without
  a state update. The next non-read-only tool call restarts it, also after choosing
  **Hide indicator** or a failed launch; read-only calls do not restart it. Concurrent
  calls in one plugin instance share a pending launch. Unloading the plugin removes
  its state file and closes the launch waiter; the helper observes removal and
  exits after its startup grace period of up to 10 seconds. Indicator failure
  does not prevent driver tool calls.
- A driver that cannot resolve a window's accessibility surface returns an **empty tree
  with `degraded_reason: ax_window_unresolved`** instead of a tree from the wrong
  surface. If you see that, the app's window changed underneath the driver; re-launch
  the app and snapshot again.

## Development

The standalone `perse-cua/native` loader entry also exposes the native provider for a host that manages its own loader row. The helper source README describes build and packaging requirements.

```sh
npm ci
npm run typecheck
npm run build      # tsc -> lib/types, then tsdown -> lib/index.js
npm run build:indicator --workspace perse-cua # macOS: build and verify the universal helper
npm test           # build + node --test test/*.test.mjs
```

Packing copies this README, its Chinese counterpart and LICENSE into the package.
The helper build compiles both macOS architectures in a temporary directory and
requires ad-hoc signing and strict verification before replacing the bundled app.
Verify the extracted archive's signature before delivery; synchronized source
folders can add Finder metadata that is absent from the npm archive. Ad-hoc signing
does not provide Developer ID or notarization.

Indicator lifecycle tests run the built plugin with real subprocess fixtures for
the driver and LaunchServices waiter. They cover exit, retry, concurrent calls and
disposal without launching a GUI. Verify status-item appearance, idle recovery and
removal separately on macOS with the packaged helper.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Xilong Liu.
