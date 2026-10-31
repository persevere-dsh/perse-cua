import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CuaConfig, installCua } from "./dsh-cua.js";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { Socket } from "node:net";
import { userInfo } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { z } from "zod";
//#region lib/types/native-build.js
/** Source-checkout preparation and installed native executable resolution. */
/**
* Validate the host before preparing a platform-specific executable.
* @param platform - Node host platform.
* @param architecture - Node host architecture.
* @returns Supported macOS architecture.
* @throws When the current host has no native implementation.
*/
function nativeHostArchitecture(platform, architecture) {
	if (platform !== "darwin" || architecture !== "arm64" && architecture !== "x64") throw new Error("Computer Use currently requires macOS on Apple silicon or Intel. Windows support is in development");
	return architecture;
}
/**
* Locate the platform-specific executable owned by the CUA package.
* @param packageRoot - Directory containing the CUA package manifest.
* @param architecture - Architecture of the process that will execute the helper.
* @returns Absolute executable path.
*/
function nativeExecutablePath(packageRoot, architecture) {
	return join(packageRoot, "native", "bin", `darwin-${architecture}`, "dsh-cua-native");
}
/**
* Recognize the repository-owned package location before allowing local compilation.
* @param packageRoot - Real directory containing this package.
* @returns True only for a CUA package in a DSH source checkout.
*/
async function isSourcePackage(packageRoot) {
	const root = resolve(packageRoot, "../../..");
	if (join(root, "packages/experimental/cua-macos") !== packageRoot) return false;
	try {
		const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		return typeof manifest === "object" && manifest !== null && "name" in manifest && manifest.name === "@deepseek-ai/dsh-root";
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
/**
* Build the package payload and retain an immutable executable for source-runtime processes.
* @param spec - Checkout, target, managed process provider and cancellation/deadline limits.
* @returns Content-addressed runtime path after compilation and complete process cleanup.
* @throws When compilation, cancellation, resource cleanup or artifact publication fails.
*/
async function buildNativeExecutable(spec) {
	spec.signal.throwIfAborted();
	const executable = nativeExecutablePath(spec.packageRoot, spec.architecture);
	await mkdir(dirname(executable), { recursive: true });
	const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(spec.timeoutMs)]);
	return withFileLock(executable, () => compileNative(spec, signal, executable), {
		waitMs: spec.timeoutMs,
		signal
	});
}
async function compileNative(spec, signal, executable) {
	const nativeRoot = join(spec.packageRoot, "native");
	const scratch = join(nativeRoot, ".build", `runtime-${spec.architecture}`);
	const handle = spec.subprocess.spawn({
		argv: [
			"/usr/bin/xcrun",
			"swift",
			"build",
			"--package-path",
			nativeRoot,
			"--scratch-path",
			scratch,
			"--configuration",
			"release",
			"--product",
			"dsh-cua-native",
			"--arch",
			spec.architecture === "x64" ? "x86_64" : "arm64"
		],
		cwd: spec.packageRoot,
		signal,
		graceMs: spec.graceMs,
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: 65536 },
			stderr: { maxBytes: 65536 }
		}
	});
	let outcome;
	try {
		outcome = await handle.done;
	} finally {
		try {
			handle.terminate();
		} finally {
			await handle.waitForExit();
		}
	}
	signal.throwIfAborted();
	if (outcome.exitCode !== 0 || outcome.signal !== null) {
		const diagnostics = `${handle.collected.stdout?.readFrom(0).text ?? ""}${handle.collected.stderr?.readFrom(0).text ?? ""}`;
		throw new Error(`Computer Use native preparation failed (${String(outcome.exitCode)}, ${String(outcome.signal)}): ${diagnostics}`);
	}
	const built = await readFile(join(scratch, "release", "dsh-cua-native"));
	let previous;
	try {
		previous = await readFile(executable);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	signal.throwIfAborted();
	if (!previous?.equals(built)) await writeFileAtomic(executable, built, { mode: 493 });
	const digest = createHash("sha256").update(built).digest("hex");
	const runtime = join(nativeRoot, ".build", "prepared", spec.architecture, digest, "dsh-cua-native");
	await mkdir(dirname(runtime), { recursive: true });
	let retained;
	try {
		retained = await readFile(runtime);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (retained && !retained.equals(built)) throw new Error("Computer Use retained executable does not match its content digest");
	signal.throwIfAborted();
	if (!retained) await writeFileAtomic(runtime, built, { mode: 493 });
	await access(runtime, constants.X_OK);
	return runtime;
}
/**
* Prepare source builds on activation; installed packages must already carry their native payload.
* @param spec - Native preparation inputs for this host.
* @returns Ready native executable without requiring a compiler for an installed package.
*/
async function prepareNativeExecutable(spec) {
	if (await isSourcePackage(spec.packageRoot)) return buildNativeExecutable(spec);
	const executable = nativeExecutablePath(spec.packageRoot, spec.architecture);
	await access(executable, constants.X_OK);
	spec.signal.throwIfAborted();
	return executable;
}
//#endregion
//#region lib/types/shared-native.js
/** Per-Agent byte connections to the per-user native screenshot process. */
const Ready = z.object({
	type: z.literal("ready"),
	protocol: z.literal(1),
	runtimeKey: z.string(),
	pid: z.number().int().positive(),
	instanceId: z.string().min(1)
}).strict();
const Refusal = z.object({
	type: z.literal("error"),
	code: z.string().min(1),
	message: z.string()
}).strict();
const handshakeByteLimit = 8192;
function transportError(code, message, cause) {
	return Object.assign(new Error(message, { cause }), { code });
}
function asError(error) {
	return error instanceof Error ? error : transportError("NATIVE_CONNECT", "Native connection failed", error);
}
async function untilAbort(operation, signal) {
	const cancelled = Promise.withResolvers();
	const abort = () => {
		cancelled.reject(signal.reason);
	};
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([operation, cancelled.promise]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
var SharedNativeChannel = class {
	owner;
	config;
	stdin;
	stdout = new PassThrough();
	done;
	ready = Promise.withResolvers();
	closed = Promise.withResolvers();
	startup = new AbortController();
	startupTimer;
	launcher;
	launcherExit;
	launcherFinished = false;
	socket;
	socketClosed;
	connected = false;
	closing = false;
	cleanupTimer;
	cleanupFailure;
	constructor(owner, config) {
		this.owner = owner;
		this.config = config;
		this.stdin = new Writable({
			write: (chunk, encoding, callback) => {
				this.ready.promise.then((socket) => {
					if (this.closing) callback(transportError("NATIVE_CLOSED", "Native connection is closing"));
					else try {
						socket.write(chunk, encoding, callback);
					} catch (error) {
						callback(asError(error));
					}
				}, callback);
			},
			final: (callback) => {
				this.close();
				callback();
			},
			destroy: (error, callback) => {
				this.close();
				callback(error);
			}
		});
		this.stdin.on("error", () => {});
		this.stdout.on("error", () => {});
		this.ready.promise.catch(() => {});
		this.closed.promise.catch(() => {});
		this.startupTimer = setTimeout(() => {
			this.startup.abort(transportError("NATIVE_CONNECT_TIMEOUT", `Native connection exceeded ${config.connectTimeoutMs}ms`));
		}, config.connectTimeoutMs);
		this.done = this.run();
		this.done.catch(() => {});
	}
	close() {
		if (this.closing) return;
		this.closing = true;
		clearTimeout(this.startupTimer);
		if (!this.connected) {
			this.startup.abort(transportError("NATIVE_CLOSED", "Native connection closed before it became ready"));
			this.socket?.destroy();
			if (!this.launcherFinished) this.launcher?.terminate();
		} else {
			this.socket?.end();
			this.cleanupTimer = setTimeout(() => {
				this.cleanupFailure = transportError("NATIVE_CLEANUP", `Native connection did not finish cleanup within ${this.config.graceMs}ms`);
				this.socket?.destroy(this.cleanupFailure);
			}, this.config.graceMs);
		}
	}
	waitForClose() {
		return this.closed.promise;
	}
	async run() {
		let failure;
		try {
			const socket = await this.connect(await this.prepare());
			this.startup.signal.throwIfAborted();
			clearTimeout(this.startupTimer);
			this.connected = true;
			this.ready.resolve(socket);
			await this.socketClosed;
		} catch (error) {
			failure = asError(this.startup.signal.aborted ? this.startup.signal.reason : error);
			this.ready.reject(failure);
			if (!this.closing) this.stdout.destroy(failure);
		} finally {
			clearTimeout(this.startupTimer);
			clearTimeout(this.cleanupTimer);
			this.closing = true;
			this.socket?.destroy();
			try {
				await this.cleanup();
			} catch (error) {
				this.cleanupFailure ??= asError(error);
			}
			this.stdin.destroy();
			if (this.cleanupFailure) {
				this.stdout.destroy(this.cleanupFailure);
				this.closed.reject(this.cleanupFailure);
			} else {
				this.stdout.end();
				this.closed.resolve();
			}
		}
		if (this.cleanupFailure) throw this.cleanupFailure;
		if (failure) throw failure;
	}
	async prepare() {
		const helperPath = await realpath(this.config.helperPath);
		const runtimeKey = createHash("sha256").update(await readFile(helperPath, { signal: this.startup.signal })).digest("hex");
		const uid = userInfo().uid;
		const directory = `/tmp/dsh-cua-${uid}`;
		try {
			await mkdir(directory, { mode: 448 });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 511) !== 448) throw transportError("NATIVE_RUNTIME_DIRECTORY", "Native runtime directory must be a real, owner-only directory owned by the current user");
		return {
			helperPath,
			runtimeKey,
			directory
		};
	}
	async ensureShared({ helperPath, runtimeKey, directory }) {
		this.startup.signal.throwIfAborted();
		this.launcherFinished = false;
		this.launcher = this.owner.subprocess.spawn({
			argv: [
				helperPath,
				"--ensure-shared",
				"--runtime-key",
				runtimeKey,
				"--runtime-directory",
				directory,
				"--startup-timeout-ms",
				String(this.config.connectTimeoutMs)
			],
			cwd: this.config.cwd,
			graceMs: this.config.graceMs,
			signal: this.startup.signal,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: 8192 },
				stderr: { maxBytes: 8192 }
			}
		});
		this.launcherExit = Promise.allSettled([this.launcher.done, this.launcher.waitForExit()]);
		const [outcome, range] = await untilAbort(this.launcherExit, this.startup.signal);
		this.launcherFinished = true;
		if (range.status === "rejected") throw range.reason;
		if (!range.value) throw transportError("NATIVE_CLEANUP", "Native launcher process range did not close");
		if (outcome.status === "rejected") throw outcome.reason;
		if (outcome.value.exitCode !== 0 || outcome.value.signal !== null) {
			const stderr = this.launcher.collected.stderr?.readFrom(0).text ?? "";
			throw transportError("NATIVE_STARTUP", `Native launcher failed (exit ${outcome.value.exitCode}, signal ${outcome.value.signal})${stderr ? `: ${stderr}` : ""}`);
		}
	}
	async connect(location) {
		for (;;) {
			await this.ensureShared(location);
			const socket = await this.connectOnce(join(location.directory, `${location.runtimeKey}.sock`), location.runtimeKey);
			if (socket) return socket;
			await setTimeout$1(25, void 0, { signal: this.startup.signal });
		}
	}
	async connectOnce(path, runtimeKey) {
		this.startup.signal.throwIfAborted();
		const socket = new Socket();
		this.socket = socket;
		const handshake = Promise.withResolvers();
		const ended = Promise.withResolvers();
		this.socketClosed = ended.promise;
		ended.promise.catch(() => {});
		let peerEnded = false;
		let socketError;
		let bytes = Buffer.alloc(0);
		const admission = { status: "pending" };
		const abort = () => {
			socket.destroy(asError(this.startup.signal.reason));
		};
		this.startup.signal.addEventListener("abort", abort, { once: true });
		socket.on("error", (error) => {
			socketError = error;
			handshake.reject(error);
		});
		socket.on("end", () => {
			peerEnded = true;
		});
		socket.on("close", () => {
			this.startup.signal.removeEventListener("abort", abort);
			const error = socketError ?? (peerEnded ? void 0 : transportError("NATIVE_EOF", "Native socket closed without cleanup acknowledgement"));
			handshake.reject(error ?? transportError("NATIVE_EOF", "Native socket ended before its handshake"));
			if (error) ended.reject(error);
			else ended.resolve();
		});
		socket.once("connect", () => {
			const { maxRequestBytes, maxResponseBytes, axTimeoutMs, textEventIntervalMs, screenshotTimeoutMs, timeoutMs, graceMs } = this.config;
			socket.write(JSON.stringify({
				type: "hello",
				protocol: 1,
				runtimeKey,
				config: {
					maxRequestBytes,
					maxResponseBytes,
					axTimeoutMs,
					textEventIntervalMs,
					screenshotTimeoutMs,
					timeoutMs,
					graceMs
				}
			}) + "\n");
		});
		const receive = (chunk) => {
			const newline = chunk.indexOf(10);
			const length = newline < 0 ? chunk.length : newline + 1;
			if (bytes.length + length > handshakeByteLimit) {
				admission.status = "refused";
				socket.destroy(transportError("NATIVE_PROTOCOL", "Native handshake exceeded its byte limit"));
				return;
			}
			bytes = Buffer.concat([bytes, chunk.subarray(0, length)]);
			if (newline < 0) return;
			try {
				const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)));
				const refusal = Refusal.safeParse(value);
				if (refusal.success) {
					admission.status = "refused";
					socket.destroy(transportError(refusal.data.code, refusal.data.message));
					return;
				}
				if (Ready.parse(value).runtimeKey !== runtimeKey) throw transportError("NATIVE_PROTOCOL", "Native handshake returned a different runtime identity");
				admission.status = "accepted";
				socket.removeListener("data", receive);
				this.startup.signal.removeEventListener("abort", abort);
				if (chunk.length > length) this.stdout.write(chunk.subarray(length));
				socket.pipe(this.stdout, { end: false });
				handshake.resolve();
			} catch (error) {
				admission.status = "refused";
				socket.destroy(transportError("NATIVE_PROTOCOL", "Native helper refused or returned an invalid handshake", error));
			}
		};
		socket.on("data", receive);
		socket.connect(path);
		try {
			await untilAbort(handshake.promise, this.startup.signal);
			return socket;
		} catch (error) {
			socket.destroy();
			await ended.promise.catch(() => {});
			if (admission.status === "pending" && error instanceof Error && "code" in error && [
				"ENOENT",
				"ECONNREFUSED",
				"ECONNRESET",
				"NATIVE_EOF"
			].includes(String(error.code))) return void 0;
			throw error;
		} finally {
			if (admission.status !== "accepted") socket.removeListener("data", receive);
		}
	}
	async cleanup() {
		if (!this.launcherFinished) this.launcher?.terminate();
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort(transportError("NATIVE_CLEANUP", `Native startup cleanup exceeded ${this.config.graceMs}ms`));
		}, this.config.graceMs);
		try {
			const [, launcher] = await untilAbort(Promise.allSettled([Promise.resolve(this.socketClosed), Promise.resolve(this.launcherExit)]), controller.signal);
			if (launcher.status === "fulfilled" && launcher.value) {
				const range = launcher.value[1];
				if (range.status === "rejected") throw range.reason;
				if (!range.value) throw transportError("NATIVE_CLEANUP", "Native launcher process range did not close");
			}
		} finally {
			clearTimeout(timer);
		}
	}
};
/**
* Prepare or join the native process; writes wait for identity-checked readiness.
* @param owner - Provider owning the short-lived native startup command.
* @param config - Native runtime identity, operation limits and connection deadlines.
* @returns One independently disposable Agent connection, without operation replay.
*/
function createSharedNativeChannel(owner, config) {
	return new SharedNativeChannel(owner, config);
}
//#endregion
//#region lib/types/guidance.js
/** macOS operation guidance supplied with the shared CUA object API. */
/** Instructions for raw operation calls and optional object-API bindings. */
const GUIDANCE = `Use cua with method getCapabilities and params {} to inspect permissions and sessionLocked. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI attempts and ask the user to unlock macOS. A null sessionLocked means no usable console session was verified. After unlocking, read fresh state; screenshots from a locked desktop are not current observations. Use listApps or cua.getState to discover running applications, and findApps(query) to search installed applications by name, bundle ID or absolute path. getApp requests user consent before launching a stopped application in the background, or before observations and input on a running one. If access is denied or revoked, stop using that application until the user explicitly grants access again. Never switch tools to bypass a refusal. Keep the returned appHandle; every app operation requires it. listWindows returns window IDs and point bounds. Raw getState returns AX text and snapshotId. Menu-bar entries are shown by default; includeMenus=true expands their contents. details=true adds identifiers, global-point bounds and complete action names. Both options also apply to getAXState. Each read replaces the indices for that app/window scope. Use its element indices only with that snapshotId. Raw screenshot and coordinate operations require a windowId. Coordinates are pixels in the latest returned screenshot, measured from its top-left. Set relative:true for integer thousandths from 0 to 1000 instead. The Host converts both modes to native window points; AX detail bounds remain global macOS points. A verified window can expose no AX elements. Its empty snapshot permits screenshots and coordinate input; element-index actions require an element from a fresh AX observation.

Initialize the object API once in persistent PTC. Reuse its variables in later calls; put temporary declarations inside { ... } blocks to avoid redeclaration errors. All object methods are async. getAXState returns text, not a structured state object. Its text separates values and placeholders, and reports subroles, help, URLs, disabled/focused/selected/expanded state and UTF-16 selection ranges when available. Writability is true, false or unknown on relevant controls; omitted state fields do not assert false. selection=unavailable means the reported range exceeds the observed text. Compact output omits ordinary Press/Pick (click), ShowMenu (right click) and ScrollToVisible actions; details=true lists every available action. Use the displayed action name with performSecondaryAction; ambiguous aliases require the complete name from details=true. Truncation reports the reached provider limit. Narrow the window or increase that provider limit before reading again.

Use app methods directly for single-window tasks; getApp already reads initial AX state. Call app.getWindows() and await app.getWindow(windowId) only to target a particular window or resolve ambiguous window selection. App screenshots and coordinate actions use the latest AX observation: its focused on-screen, nonzero-size window, otherwise the sole such window. They do not refresh focus automatically. Read app.getAXState() to follow changed focus.

CuaScreenshot contains { bytes: Uint8Array, mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif", pixelWidth: number, pixelHeight: number, windowId: number }. Use mimeType to choose a file extension or declare an image; do not assume PNG.

Object API signatures (options default to { emit: true }):

- cua.getCapabilities(options?) -> { platform, permissions, sessionLocked, methods, coordinateSpace, browser }
- cua.listApps(options?) -> Array<{ id, displayName, isRunning: true, pid }>
- cua.findApps(query: string, options?) -> Array<{ id, displayName, path, isRunning, pid? }>
- cua.getState(options?) -> { apps, browsers: [] }
- cua.getApp(selector: string) -> App
- app.activate() -> { dispatched: true, verified: false }
- app.getWindows(options?) -> Array<{ windowId, pid, appName, title, bounds, isOnScreen, onCurrentSpace }>
- app.getWindow(windowId: number) -> Window
- app.typeText(text: string), app.pressKey(chord: string) -> action result
- app.paste(text: string, options?: { format?: "text" | "html" }) -> action result

App and Window methods:

- show() -> { dispatched: true, verified: false, windowId: number | null, foregroundChanged: boolean | null }
- getAXState(options?: { emit?: boolean, disableDiffing?: boolean, includeMenus?: boolean, details?: boolean }) -> string
- getScreenshot(options?: { emit?: boolean }) -> CuaScreenshot
- getAXStateAndScreenshot(options?) -> { state: string, screenshot: CuaScreenshot }
- hover(target: number | [x, y], options?: { relative?: boolean }) -> { dispatched, verified, hoverRoute, systemPointerMoved }
- click(target: number | [x, y], options?: { mouseButton?: "left" | "right" | "middle", clickCount?: 1 | 2, modifiers?: Array<"command" | "control" | "option" | "shift" | "fn">, relative?: boolean }) -> action result
- setValue(elementIndex: number, value: string) -> action result
- selectText(elementIndex: number, text: string, options?: { prefix?: string, suffix?: string, selectionType?: "text" | "cursor_before" | "cursor_after" }) -> action result
- performSecondaryAction(elementIndex: number, action: string) -> action result
- scroll({ x, y, deltaLinesX, deltaLinesY, relative? }) -> action result
- drag(from: [x, y], to: [x, y], options?: { mouseButton?: "left" | "right" | "middle", modifiers?: Array<"command" | "control" | "option" | "shift" | "fn">, relative?: boolean }) -> action result

Raw operation tools use { method, params }, including params: {} for parameterless methods. getApp selects without activating the app. Keep applications in the background for observation and routine input. Do not activate or raise an app during initialization, before each action, or merely because another app is foreground. Prefer advertised AX actions. If a window is hidden or minimized, try app.show() or window.show() and read fresh state. show requests unhide and unminimize without activation, raising or switching Spaces; it chooses the explicit, focused, main or sole AX window. A null windowId means no window was selected for restoration. foregroundChanged compares the front app and top window before and after the request; null means unavailable, and delayed focus changes remain possible. If restoration is unsupported or the window remains unusable, including another Space or Stage Manager, explain the needed foreground step, use app.activate() or an advertised raise action, and read fresh state. Completing the task takes priority when foreground access is necessary. Avoid repeated activation when the user switches away; continue background-capable steps and report what requires foreground access. Applications may still change focus in response to input.

Await operations sequentially. After input, read fresh state to verify the effect. A successful action means dispatched, not verified completion. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again. Absolute coordinate input requires a fresh screenshot of that window. Relative input can use a successful AX observation or screenshot. SCREENSHOT_REQUIRED means capture a fresh screenshot before using pixel coordinates. For click and hover, coordinate targets must be [x, y], for example hover([650, 400], {relative:true}). A bare number such as hover(650) is always an AX element index. The relative option applies only to coordinate targets, not AX indices. Window resizing since the latest observation rejects coordinate input; movement alone preserves window-local coordinates. WINDOW_CHANGED requires fresh state before any retry; use an advertised AX action or explicitly restore the window before screenshot or coordinate input, then observe again. PERMISSION_DENIED requires the user to grant macOS Accessibility or Screen Recording access in System Settings. After granting access, observe fresh state before continuing; do not automatically replay prior input.

Hover first uses advertised AX alternate UI without moving the system cursor, preserving revealed descendants until the pointer target leaves their region. When unavailable, it returns UNSUPPORTED without moving the system cursor or activating the application. Use an advertised accessibility action or operate the control manually. Wait for the application's hover delay, observe, then hover into the revealed controls before clicking. Use successive hover calls for intermediate points. The result reports hoverRoute and systemPointerMoved. Other input or application changes can interrupt the interaction; app objects do not reserve applications between calls.

Use selectText only on controls advertising selectionWritable. It selects a unique literal occurrence, or places the cursor before/after it; prefix and suffix must be immediately adjacent. AMBIGUOUS_TEXT requires more context; TEXT_NOT_FOUND or SELECTION_CHANGED requires a fresh observation before deciding on input. Left clicks support single/double clicks; right and middle clicks support single clicks. Modified clicks use pointer input. Keypad names such as KP_0 and KP_Enter retain their physical key identity. Window objects expose observation and pointer/AX actions; keyboard input remains app-scoped and follows current focus. Scroll deltas are integer lines from -10 to 10; positive values reveal content above or left. Paste delivers plain text or HTML through the application's enabled standard Paste menu command. Paste follows the target app's focused text input. Foreground requirements vary by application; for example, ChatGPT/Codex was observed to accept background Paste without reading clipboard data. PASTE_NOT_CONSUMED means the command was dispatched but no clipboard read was observed before the configured deadline. Inspect the target contents, explicitly activate the app and focus the intended input, then observe again before deciding whether to retry; a delayed paste may still run. Original clipboard formats are restored if the clipboard still belongs to this paste; a later copy is preserved. Unsupported Paste commands fail without typing fallback. CLIPBOARD_CHANGED means another writer intervened; observe before deciding on further input. Browser applications can be controlled with getApp like other native apps; browser tabs are unavailable. Installed-app search covers standard macOS application directories; use an absolute application path for another location. Launch does not restore a window or document, and cancellation may leave an application already started. The execution host must install the object API and own variable persistence; this plugin does not preload a cua global. In persistent PTC, use the host-provided initialization snippet below once. Its installation-owned file URL works independently of the project directory. Retain app objects between calls. Observation methods emit by default and also return their value. Use void await app.getAXState() to avoid a duplicate REPL completion, or pass emit:false and print the returned text once. End screenshot calls with void await app.getScreenshot() or void await app.getAXStateAndScreenshot() so image bytes are not serialized as the program completion value.`;
//#endregion
//#region lib/types/index.js
/** macOS native CUA provider using the shared application and window API. */
/** Loader plugin identity. */
const name = "experimental-cua-macos";
/** Services required by the shared CUA executor and the native launcher. */
const inject = [
	"computerUse",
	"tools",
	"systemPrompt",
	"subprocess",
	"agents"
];
/** Validate the shared configuration before preparing the macOS helper. */
const Config = CuaConfig;
const description = "Inspect macOS permissions, select an application and window, read AX state, capture screenshots or dispatch input. Use appHandle from getApp; verify actions by reading fresh state.";
/**
* Mount logged native operations with separate Agent connections to the shared helper.
* @param ctx - Host context with computer-use, subprocess and tool services.
* @param config - Validated native preparation and operation bounds.
* @returns Completion after native preparation and tool registration.
*/
async function apply(ctx, config, hooks) {
	if (config.helperPath !== void 0) {
		if (!isAbsolute(config.helperPath)) throw new Error("dsh-cua helperPath must be absolute");
		installCua(ctx, config, {
			helperPath: config.helperPath,
			createChannel: createSharedNativeChannel,
			...hooks,
			guidance: GUIDANCE,
			description
		});
		return;
	}
	const architecture = nativeHostArchitecture(process.platform, process.arch);
	const controller = new AbortController();
	const prepared = prepareNativeExecutable({
		packageRoot: resolve(fileURLToPath(new URL("..", import.meta.url))),
		architecture,
		subprocess: ctx.subprocess,
		timeoutMs: config.buildTimeoutMs,
		graceMs: config.graceMs,
		signal: controller.signal
	});
	ctx.effect(() => async () => {
		controller.abort();
		await prepared.catch(() => {});
	}, "dsh-cua.native-preparation");
	const helperPath = await prepared;
	controller.signal.throwIfAborted();
	installCua(ctx, config, {
		helperPath,
		createChannel: createSharedNativeChannel,
		...hooks,
		guidance: GUIDANCE,
		description
	});
}
//#endregion
export { Config, GUIDANCE, apply, inject, name };
