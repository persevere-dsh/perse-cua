# perse-cua

English | [中文](README.zh.md)

`perse` = persevere

Desktop automation for DSH: macOS uses the native `cua` tool; other platforms default to [cua-driver](https://github.com/trycua/cua) MCP.

**Part of Persevere with DSH**

-----

On macOS 14 or later this plugin uses the DSH native provider and rejects the MCP backend and MCP driver settings. The model uses the registered `cua` tool and its per-application authorization flow. Background AX operations and screenshots are supported; typed browser tabs are not. If a capability is unavailable, report the limitation. Profile tool admission is optional, including on the official DSH 0.2.1-rc.2 host. Preview captures use the same application authorization without changing model screenshot coordinates. The driver measurements and behavior below apply to `backend: mcp` on other platforms.

When the host supports required-tool health reporting, tool registration leaves connection readiness unknown until an operation succeeds, and native transport failures are reported for the owning session. A transport failure also appears in its preview. A missing helper or provider startup failure prevents native startup and is reported to the host when it supports startup failure reporting.

Native hover uses AX alternate UI when available. Otherwise it returns `UNSUPPORTED` without activating the app or moving the system pointer; use an advertised accessibility action or operate the control manually. Leaving previously revealed alternate UI may restore it before this error. A newly revealed alternate UI reports `dispatched: true`; entering an already revealed descendant reports `dispatched: false` because no new AX action is sent; consumers must accept either boolean. Both report `verified: false`, `hoverRoute: "accessibility"`, and `systemPointerMoved: false`; inspect fresh state to confirm the effect. Successful hover displays a virtual cursor at the target position observed before the action; it may be stale if the target moves during the action and does not verify the result. Disconnecting drops hover tracking without restoring the application UI. AX clicks with available target geometry also display the native cursor and click marker. The marker remains fully visible for 1.5 seconds before fading over 0.5 seconds, unless another input or an error hides it sooner. The separate cursor window is excluded from native window captures.

Existing macOS configurations must remove `backend: mcp` and MCP-specific options such as `command`, `args`, `allow`, and `indicator`. Some hosts suppress known conflicting CUA driver entries and migrate matching saved profile entries with a backup; the official DSH 0.2.1-rc.2 host does not provide this admission policy. For a read-only presenter in a macOS profile, use the `perse-cua/presenter` entrypoint; `presenterOnly: true` on the main entry cannot release the native requirement. Automatic native previews require this plugin to own the provider and its authorization lifecycle.

## What the MCP backend solves on other platforms

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

## What the MCP backend does on other platforms

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
4. **Enables the MCP best experience** by default: at boot the plugin opens a named
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

On platforms that use the MCP backend, opt in to the aggressive cut explicitly if request size matters more than reach:

```yaml
- id: perse-cua
  config:
    backend: mcp
    allow: !!js (await import('perse-cua')).MINIMAL_ALLOW
```

## Use this plugin

`perse-cua` ships `dsh.bundle.patch`, so installing it already registers its loader row.
macOS requires the native backend and no backend override. On other platforms, select the external MCP driver with a **config override** — not a second `insert`, which would collide on the loader id
(preflight rule R-07):

```yaml
- id: perse-cua
  config:
    backend: mcp
    command: /Users/you/.local/bin/cua-driver
    serverName: cua
```

Install the plugin and remove any plain `dsh-mcp-client` row pointed at the same driver:

```sh
npm pack --workspace perse-cua
dsh plugin --profile web add ./perse-cua-0.3.1-rc.3.tgz
```

### Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `presenterOnly` | `false` | Provide only the preview service outside macOS profiles; macOS profiles use `perse-cua/presenter` |
| `backend` | `native` on macOS; `mcp` elsewhere | macOS requires `native` and macOS 14 or later; `mcp` is available on other platforms |
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

Native previews refresh after observed operations using the same application authorization. Closing a preview suppresses automatic rediscovery; a later operation on that window can show it again, while listing windows leaves it closed. A failed call clears the image and triggers a fresh capture; only a failed preview capture marks the screenshot unavailable. Permission denial clears affected frames and suspends automatic capture until another CUA operation. Other discovery failures report the affected application without stopping unrelated applications. Turn completion or cancellation stops background captures and marks the retained frame; a later turn resumes capture after it uses CUA. Previews are scoped to the selected Session and the Remote gateway authorizes access to that Session.

With the MCP backend, the plugin streams separate window images to its browser client. It identifies targets from window reads and window-targeted actions, and preserves the action session when requesting a preview. Select a card to enlarge it, switch windows, or close a card. The image time is the response receipt time. A brief click indicator appears only when the driver accepts a pixel click bound to the same window, session, and captured image; it is an action marker, while the actual agent cursor is rendered by the driver on the target window and may not appear in window screenshots. Actions without a verified pixel position show no marker. The plugin checks the target window list before publishing a preview; an off-screen or absent window keeps its last image and time and is marked unavailable. If capture or enumeration fails, the card marks the screenshot unavailable; dismiss it when no longer needed. The client clears stale cards and retries an unexpectedly ended preview stream. A preview requires an Agent owner and the host Remote gateway and client slots.

The exported `PreviewService` can also receive `put` and `remove` calls from a different provider. That provider owns authorization, cursor behavior, and removing its windows.

The `perse-cua/presenter` entry registers only the preview service and never starts or configures the driver. Its provider owns authorization and cursor behavior. The action-position marker identifies the submitted point on the matching captured image; a driver may dispatch that action using accessibility rather than a pointer press.

## What it deliberately does not do

- **No reconnect.** A driver process that dies is reported as a failed call; the next
  call fails too until the harness reloads the plugin. cua-driver is a local process,
  and silent respawn was judged worse than a visible failure.

## Platform notes

- The macOS native backend needs Accessibility and Screen Recording permission for the responsible host/helper.
- MCP backend actions run in the background by default and do not steal the user's focus.
  `move_cursor` in its default window scope paints the agent overlay only; moving the
  real OS pointer needs `scope: "desktop"`, which is a foreground takeover.
- The legacy MCP menu-bar indicator starts with the plugin where supported and exits after 60 seconds without
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
