// ../dsh-remote-native-integration/packages/experimental/cua/src/api.ts
import { Buffer as Buffer2 } from "node:buffer";

// ../dsh-remote-native-integration/packages/experimental/cua/src/protocol.ts
import { Buffer } from "node:buffer";
import { z } from "zod";
var id = z.number().int().positive().max(2 ** 32 - 1);
var pid = z.number().int().positive().max(2 ** 31 - 1);
var point = z.number().nonnegative();
var relativePoint = z.number().int().min(0).max(1e3);
var app = { appHandle: z.string().min(1) };
var pointer = {
  mouseButton: z.enum(["left", "right", "middle"]).optional(),
  modifiers: z.array(z.enum(["command", "control", "option", "shift", "fn"])).optional()
};
var window = { ...app, windowId: id };
var snapshot = { ...app, snapshotId: z.string().min(1), elementIndex: z.number().int().nonnegative() };
var coordinate = { ...window, snapshotId: z.string().min(1).optional(), x: point, y: point };
var absoluteCoordinate = { ...coordinate, relative: z.literal(false).optional().describe("Omitted or false uses pixels in the latest screenshot returned by this tool.") };
var relativeCoordinate = { ...coordinate, relative: z.literal(true).describe("Use integer thousandths of the window width and height, from 0 to 1000."), x: relativePoint, y: relativePoint };
var bounds = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative()
});
var operation = (method, params) => z.object({
  method: z.literal(method),
  params: z.object(params).strict()
}).strict();
var imageBase64 = z.string().min(1).refine((value) => Buffer.from(value, "base64").toString("base64") === value, {
  message: "Expected canonical base64 image data"
});
var NativeRequest = z.discriminatedUnion("method", [
  operation("getCapabilities", {}),
  operation("listApps", {}),
  operation("findApps", { query: z.string().min(1, "Expected a non-empty search string").regex(/\S/, "Expected a non-empty search string") }),
  operation("getApp", { selector: z.string().min(1), instance: z.enum(["existingOrLaunch", "new"]).optional() }),
  operation("activate", app),
  operation("show", { ...app, windowId: id.optional() }),
  operation("listWindows", app),
  operation("getState", {
    ...app,
    windowId: id.optional(),
    includeMenus: z.boolean().optional().describe("Expand menu contents; omitted or false shows menu-bar entries only."),
    details: z.boolean().optional().describe("Include identifiers, global-point bounds and complete action names.")
  }),
  z.object({ method: z.literal("hover"), params: z.union([
    z.object(snapshot).strict(),
    z.object(absoluteCoordinate).strict(),
    z.object(relativeCoordinate).strict()
  ]) }).strict(),
  z.object({ method: z.literal("click"), params: z.union([
    z.object({ ...snapshot, ...pointer, clickCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
    z.object({ ...absoluteCoordinate, ...pointer, clickCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
    z.object({ ...relativeCoordinate, ...pointer, clickCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict()
  ]) }).strict(),
  operation("setValue", { ...snapshot, value: z.string() }),
  operation("selectText", {
    ...snapshot,
    text: z.string().min(1),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    selectionType: z.enum(["text", "cursor_before", "cursor_after"]).optional()
  }),
  operation("performSecondaryAction", { ...snapshot, action: z.string().min(1) }),
  operation("typeText", { ...app, text: z.string() }),
  operation("paste", { ...app, text: z.string(), format: z.enum(["text", "html"]).optional() }),
  operation("pressKey", { ...app, key: z.string().min(1), modifiers: z.array(z.enum(["command", "control", "option", "shift", "fn"])).optional() }),
  z.object({ method: z.literal("scroll"), params: z.union([
    z.object({
      ...absoluteCoordinate,
      deltaLinesX: z.number().int().min(-10).max(10),
      deltaLinesY: z.number().int().min(-10).max(10)
    }).strict(),
    z.object({
      ...relativeCoordinate,
      deltaLinesX: z.number().int().min(-10).max(10),
      deltaLinesY: z.number().int().min(-10).max(10)
    }).strict()
  ]) }).strict(),
  z.object({ method: z.literal("drag"), params: z.union([
    z.object({
      ...window,
      ...pointer,
      snapshotId: z.string().min(1).optional(),
      relative: z.literal(false).optional(),
      fromX: point,
      fromY: point,
      toX: point,
      toY: point
    }).strict(),
    z.object({
      ...window,
      ...pointer,
      snapshotId: z.string().min(1).optional(),
      relative: z.literal(true),
      fromX: relativePoint,
      fromY: relativePoint,
      toX: relativePoint,
      toY: relativePoint
    }).strict()
  ]) }).strict(),
  operation("screenshot", window)
]);
var Request = z.discriminatedUnion("method", [
  ...NativeRequest.options,
  operation("saveScreenshot", window)
]);
var NativeResourceParameters = {
  getState: z.object({ maxElements: z.number().int().min(1).max(1e4), maxDepth: z.number().int().min(1).max(100) }).strict(),
  drag: z.object({ durationMs: z.number().int().min(1).max(5e3), steps: z.number().int().min(1).max(240) }).strict(),
  paste: z.object({
    maxClipboardBytes: z.number().int().min(1024),
    pasteReadTimeoutMs: z.number().int().min(1).max(2 ** 31 - 1),
    maxElements: z.number().int().min(1).max(1e4),
    maxDepth: z.number().int().min(1).max(100)
  }).strict(),
  findApps: z.object({ maxAppMatches: z.number().int().min(1).max(1e3) }).strict()
};
var NativeOnlyOperations = [operation("launchApp", app)];
var AppResult = z.object({
  appHandle: z.string().min(1).transform((value) => value),
  pid,
  name: z.string(),
  bundleId: z.string().optional()
});
var AppsResult = z.array(z.object({ pid, name: z.string(), bundleId: z.string().optional() }));
var FoundAppsResult = z.array(z.intersection(
  z.object({ id: z.string().min(1), displayName: z.string(), path: z.string().min(1) }),
  z.discriminatedUnion("isRunning", [z.object({ isRunning: z.literal(true), pid }), z.object({ isRunning: z.literal(false) })])
));
var WindowsResult = z.array(z.object({
  windowId: id,
  pid,
  appName: z.string(),
  title: z.string(),
  bounds,
  isOnScreen: z.boolean(),
  onCurrentSpace: z.boolean().nullable()
}));
var StateResult = z.object({
  appHandle: z.string().min(1).transform((value) => value),
  pid,
  windowId: id.nullable(),
  focusedWindowId: id.nullable().optional(),
  snapshotId: z.string().min(1).transform((value) => value),
  tree: z.string(),
  windows: WindowsResult,
  truncated: z.boolean()
});
var NativeScreenshotResult = z.object({
  mimeType: z.literal("image/png"),
  data: imageBase64,
  pixelWidth: id,
  pixelHeight: id,
  windowId: id,
  bounds: bounds.extend({ width: z.number().positive(), height: z.number().positive() }),
  coordinateSpace: z.literal("window-points")
});
var ScreenshotArtifactResult = z.object({
  path: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  pixelWidth: id,
  pixelHeight: id,
  windowId: id,
  purpose: z.literal("User screenshot artifact; the model has not seen its pixels."),
  modelReceivedImage: z.literal(false)
});
var ScreenshotResult = NativeScreenshotResult.extend({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  coordinateSpace: z.literal("screenshot-pixels")
});
var CapabilitiesResult = z.object({
  platform: z.string(),
  permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }),
  sessionLocked: z.boolean().nullable(),
  methods: z.array(z.string()),
  coordinateSpace: z.literal("screenshot-pixels"),
  browser: z.literal(false)
});
var ActionResult = z.object({ dispatched: z.literal(true), verified: z.literal(false) });
var HoverResult = ActionResult.extend({ hoverRoute: z.enum(["accessibility", "system-pointer"]), systemPointerMoved: z.boolean() });
var ShowResult = ActionResult.extend({ windowId: id.nullable(), foregroundChanged: z.boolean().nullable() });

// ../dsh-remote-native-integration/packages/experimental/cua/src/api.ts
function requestIssueMessage(issues, parent = []) {
  return [...new Set(issues.map((issue) => {
    const path = [...parent, ...issue.path];
    if (issue.code === "invalid_union") {
      const fewest = Math.min(...issue.errors.map((branch) => branch.length));
      return [...new Set(issue.errors.filter((branch) => branch.length === fewest).map((branch) => requestIssueMessage(branch, path)))].join(" or ");
    }
    const fields = path.slice(1);
    if (issue.code === "unrecognized_keys") {
      return `${issue.keys.map((key) => [...fields, key].join(".")).join(", ")}: not accepted for these arguments`;
    }
    return `${fields.join(".")}: ${issue.message}`;
  }))].join("; ");
}
function keyChord(chord) {
  const parts = chord.split("+");
  let key = parts.pop();
  if (key === "" && parts.at(-1) === "") {
    key = "+";
    parts.pop();
  }
  if (!key) throw new Error("A key chord must end with a key name");
  const names = {
    cmd: "command",
    command: "command",
    super: "command",
    Super_L: "command",
    Super_R: "command",
    ctrl: "control",
    control: "control",
    Control_L: "control",
    Control_R: "control",
    alt: "option",
    option: "option",
    Alt_L: "option",
    Alt_R: "option",
    shift: "shift",
    Shift_L: "shift",
    Shift_R: "shift",
    fn: "fn"
  };
  return { key, modifiers: parts.map((part) => {
    const modifier = names[part];
    if (modifier === void 0) throw new Error(`Unsupported key modifier: ${part}`);
    return modifier;
  }) };
}
function createCuaApi(dispatch, sink) {
  const call = (method, params) => {
    const request = Request.safeParse({ method, params });
    if (!request.success) throw new Error(`${method} ${requestIssueMessage(request.error.issues)}`);
    return dispatch(request.data);
  };
  const action = async (method, params) => ActionResult.parse(await call(method, params));
  async function emit(value, options) {
    if (options?.emit !== false) await sink?.text(JSON.stringify(value));
  }
  function surface(appHandle, pid2, selectedWindow) {
    let observed;
    function snapshotParams() {
      if (!observed) throw new Error("Read getAXState before using this surface");
      return { appHandle, snapshotId: observed.snapshotId };
    }
    function windowId() {
      if (selectedWindow !== void 0) return selectedWindow;
      const windows = observed?.windows.filter((window2) => window2.isOnScreen && window2.bounds.width > 0 && window2.bounds.height > 0);
      const focused = windows?.find((window2) => window2.windowId === observed?.focusedWindowId);
      if (focused) return focused.windowId;
      const first = windows?.[0];
      if (!first || windows.length !== 1) throw new Error("Select a window with app.getWindows() and app.getWindow(windowId) before this operation");
      return first.windowId;
    }
    const result = {
      async show() {
        return ShowResult.parse(await call("show", {
          appHandle,
          ...selectedWindow === void 0 ? {} : { windowId: selectedWindow }
        }));
      },
      async getAXState(options) {
        observed = void 0;
        const state = StateResult.parse(await call("getState", {
          appHandle,
          ...selectedWindow === void 0 ? {} : { windowId: selectedWindow },
          ...options?.includeMenus === void 0 ? {} : { includeMenus: options.includeMenus },
          ...options?.details === void 0 ? {} : { details: options.details }
        }));
        if (state.appHandle !== appHandle || state.pid !== pid2 || state.windowId !== (selectedWindow ?? null)) {
          throw new Error("Native observation belongs to another application or window");
        }
        if (state.windows.some((window2) => window2.pid !== pid2)) throw new Error("Native windows belong to another application");
        observed = state;
        if (options?.emit !== false) await sink?.text(state.tree);
        return state.tree;
      },
      async getScreenshot(options) {
        if (!observed) await result.getAXState({ emit: false });
        const target = windowId();
        const image = ScreenshotResult.parse(await call("screenshot", { appHandle, windowId: target }));
        if (image.windowId !== target) throw new Error("Native screenshot belongs to another window");
        const screenshot = {
          bytes: Uint8Array.from(Buffer2.from(image.data, "base64")),
          mimeType: image.mimeType,
          pixelWidth: image.pixelWidth,
          pixelHeight: image.pixelHeight,
          windowId: image.windowId
        };
        if (options?.emit !== false) await sink?.image(screenshot);
        return screenshot;
      },
      async saveScreenshot(options) {
        if (!observed) await result.getAXState({ emit: false });
        const target = windowId();
        const artifact = ScreenshotArtifactResult.parse(await call("saveScreenshot", { appHandle, windowId: target }));
        if (artifact.windowId !== target) throw new Error("Screenshot artifact belongs to another window");
        await emit(artifact, options);
        return artifact;
      },
      async getAXStateAndScreenshot(options) {
        const state = await result.getAXState(options);
        return { state, screenshot: await result.getScreenshot(options) };
      },
      async hover(target, options) {
        const relative = options?.relative === void 0 ? {} : { relative: options.relative };
        if (typeof target === "number") return HoverResult.parse(await call("hover", { ...snapshotParams(), elementIndex: target, ...relative }));
        const [x, y] = target;
        return HoverResult.parse(await call("hover", { ...snapshotParams(), windowId: windowId(), x, y, ...relative }));
      },
      async click(target, options) {
        const mouseButton = options?.mouseButton ?? "left";
        const clickCount = options?.clickCount ?? 1;
        if (mouseButton !== "left" && clickCount !== 1) throw new Error("Only left double-click is supported");
        const modifiers = options?.modifiers === void 0 ? {} : { modifiers: [...options.modifiers] };
        const relative = options?.relative === void 0 ? {} : { relative: options.relative };
        if (typeof target === "number") {
          return action("click", {
            ...snapshotParams(),
            ...modifiers,
            ...relative,
            elementIndex: target,
            ...mouseButton === "left" ? {} : { mouseButton },
            ...clickCount === 1 ? {} : { clickCount }
          });
        }
        const [x, y] = target;
        return action("click", { ...snapshotParams(), windowId: windowId(), x, y, mouseButton, clickCount, ...modifiers, ...relative });
      },
      async setValue(index, value) {
        return action("setValue", { ...snapshotParams(), elementIndex: index, value });
      },
      async selectText(index, text, options) {
        return action("selectText", {
          ...snapshotParams(),
          elementIndex: index,
          text,
          ...options?.prefix === void 0 ? {} : { prefix: options.prefix },
          ...options?.suffix === void 0 ? {} : { suffix: options.suffix },
          ...options?.selectionType === void 0 ? {} : { selectionType: options.selectionType }
        });
      },
      async performSecondaryAction(index, name) {
        return action("performSecondaryAction", { ...snapshotParams(), elementIndex: index, action: name });
      },
      async scroll(options) {
        if (options.deltaLinesX === 0 && options.deltaLinesY === 0) throw new Error("At least one scroll delta must be nonzero");
        return action("scroll", {
          ...snapshotParams(),
          windowId: windowId(),
          x: options.x,
          y: options.y,
          deltaLinesX: options.deltaLinesX,
          deltaLinesY: options.deltaLinesY,
          ...options.relative === void 0 ? {} : { relative: options.relative }
        });
      },
      async drag(from, to, options) {
        return action("drag", {
          ...snapshotParams(),
          windowId: windowId(),
          fromX: from[0],
          fromY: from[1],
          toX: to[0],
          toY: to[1],
          ...options?.relative === void 0 ? {} : { relative: options.relative },
          ...options?.mouseButton === void 0 ? {} : { mouseButton: options.mouseButton },
          ...options?.modifiers === void 0 ? {} : { modifiers: [...options.modifiers] }
        });
      }
    };
    return result;
  }
  const api = {
    async getCapabilities(options) {
      const result = CapabilitiesResult.parse(await call("getCapabilities", {}));
      await emit(result, options);
      return result;
    },
    async listApps(options) {
      const result = AppsResult.parse(await call("listApps", {})).map((app2) => ({
        id: app2.bundleId || String(app2.pid),
        displayName: app2.name,
        isRunning: true,
        pid: app2.pid
      }));
      await emit(result, options);
      return result;
    },
    async findApps(query, options) {
      const result = FoundAppsResult.parse(await call("findApps", { query }));
      await emit(result, options);
      return result;
    },
    async getState(options) {
      const result = { apps: await api.listApps({ emit: false }), browsers: [] };
      await emit(result, options);
      return result;
    },
    async getApp(selector, options) {
      const { appHandle, pid: pid2 } = AppResult.parse(await call("getApp", { selector, ...options?.instance === void 0 ? {} : { instance: options.instance } }));
      const app2 = {
        ...surface(appHandle, pid2),
        pid: pid2,
        appHandle,
        async activate() {
          return action("activate", { appHandle });
        },
        async getWindows(options2) {
          const windows = WindowsResult.parse(await call("listWindows", { appHandle }));
          if (windows.some((window2) => window2.pid !== pid2)) throw new Error("Native windows belong to another application");
          await emit(windows, options2);
          return windows;
        },
        async getWindow(windowId) {
          const window2 = { ...surface(appHandle, pid2, windowId), windowId };
          await window2.getAXState();
          return window2;
        },
        async typeText(text) {
          return action("typeText", { appHandle, text });
        },
        async paste(text, options2) {
          return action("paste", {
            appHandle,
            text,
            ...options2?.format === void 0 ? {} : { format: options2.format }
          });
        },
        async pressKey(key) {
          return action("pressKey", { appHandle, ...keyChord(key) });
        }
      };
      await app2.getAXState();
      return app2;
    }
  };
  return api;
}

// ../dsh-remote-native-integration/packages/experimental/cua/src/bridge.ts
function connectCua(getTool, onText) {
  return createCuaApi((operation2) => getTool()(operation2), {
    text: (value) => onText?.(value),
    // The standard tools.cua result already carries the screenshot attachment.
    image: () => {
    }
  });
}
export {
  connectCua
};
