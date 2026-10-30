import { join } from "node:path";
import { Buffer as Buffer$1 } from "node:buffer";
import { tmpdir } from "node:os";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import Schema from "@deepseek-ai/schemastery";
import { ComputerUseProviderName } from "@deepseek-ai/dsh-computer-use/brand";
import { admitEncodedImages } from "@deepseek-ai/dsh-attachment";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
//#region lib/types/native-client.js
/** Agent-scoped JSONL requests over a connection to the shared native helper. */
const Reply = z.union([z.object({
	id: z.string(),
	result: z.json()
}).strict(), z.object({
	id: z.string(),
	error: z.object({
		code: z.string().min(1),
		message: z.string()
	}).strict()
}).strict()]);
const screenshotPrefix = "[cua-screenshot] ";
const ScreenshotDiagnostic = z.object({
	requestId: z.string(),
	stage: z.string(),
	elapsedMs: z.number().nonnegative(),
	errorCode: z.string().optional()
});
const WireReply = z.union([Reply, ScreenshotDiagnostic.extend({ type: z.literal("diagnostic") })]);
/** Native refusal or transport failure with a stable machine-readable code. */
var NativeError = class extends Error {
	code;
	/**
	* @param code - Native error code or a transport-owned NATIVE_* code.
	* @param message - Actionable diagnostic, without its code prefix.
	* @param options - Original failure when available.
	*/
	constructor(code, message, options) {
		super(`${code}: ${message}`, options);
		this.code = code;
		this.name = "NativeError";
	}
};
/** One Agent owns this connection and its native handles; other Agents use independent connections. */
var NativeClient = class {
	reportDiagnostic;
	handle;
	config;
	chunks = [];
	bufferedBytes = 0;
	failure;
	disposal;
	diagnostics = [];
	diagnosticBytes = 0;
	discardedDiagnostics = false;
	active;
	/**
	* @param owner - Managed subprocess provider.
	* @param config - Executable, transport bounds and deadlines.
	* @param createChannel - Platform-owned connection and process lifecycle.
	* @param reportDiagnostic - Optional Host diagnostic sink; never receives captured content.
	*/
	constructor(owner, config, createChannel, reportDiagnostic) {
		this.reportDiagnostic = reportDiagnostic;
		this.config = config;
		this.handle = createChannel(owner, config);
		this.handle.stdout.on("data", (chunk) => {
			this.receive(chunk);
		});
		this.handle.stdout.on("error", (error) => {
			this.fail(new NativeError("NATIVE_IO", `Native connection failed: ${error.message}`, { cause: error }));
		});
		this.handle.stdout.on("end", () => {
			this.fail(new NativeError("NATIVE_EOF", "Native connection ended; acquire fresh application handles"));
		});
		this.handle.stdout.on("close", () => {
			this.fail(new NativeError("NATIVE_EOF", "Native connection closed; acquire fresh application handles"));
		});
		this.handle.stdin.on("error", (error) => {
			this.fail(new NativeError("NATIVE_IO", "Writing native requests failed", { cause: error }));
		});
		this.handle.done.then(() => {
			this.fail(new NativeError("NATIVE_EXITED", "Native connection closed; acquire fresh application handles"));
		}, (error) => {
			this.fail(new NativeError("NATIVE_EXITED", "Native connection failed", { cause: error }));
		});
	}
	/**
	* Send one operation. Native refusals preserve this connection; transport failures invalidate its handles.
	* @param method - Helper operation name.
	* @param params - JSON operation parameters.
	* @param signal - Cancellation stops this request; the connection survives when native cleanup acknowledges it.
	* @param callId - Logged tool invocation ID, when this request belongs to a tool execution.
	* @returns The validated helper result, after failure cleanup when needed.
	*/
	async request(method, params, signal, callId) {
		if (signal.aborted) throw new NativeError("NATIVE_CANCELLED", "Operation was cancelled before dispatch");
		if (this.disposed) {
			await this.dispose();
			throw new NativeError("NATIVE_CLOSED", "Helper is closed; acquire fresh application handles", { cause: this.failure });
		}
		if (this.active) throw new NativeError("NATIVE_BUSY", "Await native operations sequentially");
		const id = callId ?? randomUUID();
		const capture = method === "screenshot";
		this.diagnostics = [];
		this.diagnosticBytes = 0;
		this.discardedDiagnostics = false;
		const started = performance.now();
		let nativeFailure;
		let interruption;
		let cancellationTimer;
		const frame = `${JSON.stringify({
			id,
			method,
			params
		})}\n`;
		if (Buffer.byteLength(frame) > this.config.maxRequestBytes) throw new NativeError("NATIVE_REQUEST_LIMIT", "Request exceeded the configured byte limit before dispatch");
		const outcome = Promise.withResolvers();
		this.active = {
			id,
			resolve: outcome.resolve,
			reject: (error) => {
				nativeFailure = error;
				outcome.reject(error);
			}
		};
		if (capture) this.diagnostic(screenshotPrefix + JSON.stringify({
			requestId: id,
			stage: "host.dispatch",
			elapsedMs: 0
		}));
		const interrupt = (error) => {
			if (interruption || this.active?.id !== id) return;
			interruption = error;
			cancellationTimer = setTimeout(() => {
				this.fail(new NativeError("NATIVE_CLEANUP", "Native operation did not acknowledge cancellation; acquire fresh application handles", { cause: error }));
			}, this.config.graceMs);
			try {
				this.handle.stdin.write(`${JSON.stringify({
					type: "cancel",
					id
				})}\n`, (failure) => {
					if (failure) this.fail(new NativeError("NATIVE_IO", "Sending native cancellation failed", { cause: failure }));
				});
			} catch (failure) {
				this.fail(new NativeError("NATIVE_IO", "Sending native cancellation failed", { cause: failure }));
			}
		};
		const abort = () => {
			interrupt(new NativeError("NATIVE_CANCELLED", "Operation cancelled; inspect fresh state before retrying input"));
		};
		signal.addEventListener("abort", abort, { once: true });
		const timeoutMs = capture ? Math.min(this.config.timeoutMs, this.config.screenshotTimeoutMs) : this.config.timeoutMs;
		const timer = setTimeout(() => {
			interrupt(new NativeError("NATIVE_TIMEOUT", `Operation exceeded ${timeoutMs}ms`));
		}, timeoutMs);
		try {
			try {
				this.handle.stdin.write(frame, (error) => {
					if (error) this.fail(new NativeError("NATIVE_IO", "Writing a helper request failed", { cause: error }));
				});
			} catch (error) {
				this.fail(new NativeError("NATIVE_IO", "Writing a helper request failed", { cause: error }));
			}
			const result = await outcome.promise;
			if (this.failure) throw this.failure;
			if (interruption) throw interruption;
			if (capture) this.diagnostic(screenshotPrefix + JSON.stringify({
				requestId: id,
				stage: "host.reply",
				elapsedMs: performance.now() - started
			}));
			return result;
		} catch (error) {
			if (interruption && !this.failure) throw interruption;
			throw error;
		} finally {
			clearTimeout(timer);
			clearTimeout(cancellationTimer);
			signal.removeEventListener("abort", abort);
			try {
				if (this.failure !== void 0) await this.dispose();
			} finally {
				if (capture) {
					const diagnostics = this.screenshotDiagnostics();
					const failure = this.failure ?? interruption ?? nativeFailure;
					if (failure && diagnostics) failure.message += `\nScreenshot diagnostics:\n${diagnostics}`;
					if (diagnostics) this.diagnostic(diagnostics);
					this.diagnostic(screenshotPrefix + JSON.stringify({
						requestId: id,
						stage: "host.settled",
						elapsedMs: performance.now() - started
					}));
				}
			}
		}
	}
	screenshotDiagnostics() {
		const records = [...this.diagnostics];
		if (this.discardedDiagnostics) records.unshift("[Earlier screenshot diagnostic records were discarded from the bounded diagnostic buffer.]");
		return records.join("\n");
	}
	retainDiagnostic(value) {
		if (value.requestId !== this.active?.id) return;
		const line = screenshotPrefix + JSON.stringify(ScreenshotDiagnostic.parse(value));
		this.diagnostics.push(line);
		this.diagnosticBytes += Buffer.byteLength(line);
		while (this.diagnosticBytes > 8192) {
			const discarded = this.diagnostics.shift();
			assert(discarded !== void 0, "Diagnostic bytes must belong to retained records");
			this.diagnosticBytes -= Buffer.byteLength(discarded);
			this.discardedDiagnostics = true;
		}
	}
	diagnostic(message) {
		try {
			this.reportDiagnostic?.(message);
		} catch (error) {}
	}
	/** Whether this Agent's connection has lost its retained native state. */
	get disposed() {
		return this.failure !== void 0;
	}
	/** Invalidate this Agent's handles and close its connection; await dispose for native cleanup. */
	invalidate() {
		this.fail(new NativeError("NATIVE_DISPOSED", "Helper disposed"));
	}
	/** Stop this Agent's pending work and await its native connection cleanup. */
	dispose() {
		this.invalidate();
		this.disposal ??= (async () => {
			try {
				await this.handle.waitForClose();
			} finally {
				this.handle.stdout.destroy();
				this.handle.stdin.destroy();
			}
		})();
		return this.disposal;
	}
	fail(error) {
		if (this.failure) return;
		this.failure = error;
		this.chunks.length = 0;
		this.bufferedBytes = 0;
		this.active?.reject(error);
		this.active = void 0;
		this.handle.close();
	}
	receive(chunk) {
		let offset = 0;
		while (offset < chunk.length && !this.failure) {
			const newline = chunk.indexOf(10, offset);
			const end = newline < 0 ? chunk.length : newline + 1;
			const piece = chunk.subarray(offset, end);
			if (this.bufferedBytes + piece.length > this.config.maxResponseBytes) {
				this.fail(new NativeError("NATIVE_RESPONSE_LIMIT", "Helper response exceeded the configured byte limit"));
				return;
			}
			this.chunks.push(piece);
			this.bufferedBytes += piece.length;
			if (newline >= 0) this.receiveFrame();
			offset = end;
		}
	}
	receiveFrame() {
		try {
			const frame = Buffer.concat(this.chunks, this.bufferedBytes);
			const line = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, frame.length - 1));
			const reply = WireReply.parse(JSON.parse(line));
			this.chunks.length = 0;
			this.bufferedBytes = 0;
			if ("type" in reply) {
				this.retainDiagnostic(reply);
				return;
			}
			const active = this.active;
			if (!active || reply.id !== active.id) throw new Error("Helper reply has no matching request");
			this.active = void 0;
			if ("error" in reply) {
				const error = new NativeError(reply.error.code, reply.error.message);
				if (reply.error.code === "NATIVE_RESPONSE_LIMIT") this.fail(error);
				active.reject(error);
			} else active.resolve(reply.result);
		} catch (error) {
			this.fail(new NativeError("NATIVE_PROTOCOL", "Helper returned an invalid response; acquire fresh application handles", { cause: error }));
		}
	}
};
//#endregion
//#region lib/types/application-access.js
/** Native identity admission occurs before any application observation or input. */
const ApplicationAuthorizationResult = z.object({
	id: z.string().regex(/^[a-f0-9]{64}$/).transform((value) => value),
	name: z.string(),
	executablePath: z.string().min(1),
	persistable: z.boolean()
});
/** Owns application consent and cancels operations when saved access is removed. */
var ApplicationAccess = class {
	ctx;
	options;
	clients = /* @__PURE__ */ new Map();
	rejected = /* @__PURE__ */ new Map();
	active = /* @__PURE__ */ new Set();
	selections = /* @__PURE__ */ new WeakMap();
	lifetime = new AbortController();
	mutationTail = Promise.resolve();
	disposal;
	/** @param ctx Host context owning this provider. @param options Live saved grants and profile persistence. */
	constructor(ctx, options) {
		this.ctx = ctx;
		this.options = options;
		if (options.onVolatile) options.onVolatile(() => this.reconcile());
		else ctx.on("loader/volatile-update", () => this.reconcile());
		ctx.effect(() => () => this.dispose(), "cua-application-access.dispose");
	}
	/**
	* Cancel consent waits and join owned operations.
	* @returns Completion after consent waits and active operations settle.
	*/
	dispose() {
		return this.disposal ??= (async () => {
			this.lifetime.abort();
			await Promise.allSettled([this.mutationTail, ...[...this.active].map((operation) => operation.done.promise)]);
			this.clients.clear();
			this.rejected.clear();
		})();
	}
	/**
	* Obtain consent for a freshly selected native handle. Free text never grants access.
	* @param agent Exact live task requesting access.
	* @param client Helper that issued the handle.
	* @param handle Helper handle for a running instance or an approved pending launch.
	* @param identity Native executable/signing identity.
	* @param signal Calling tool lifetime.
	* @returns Completion after consent; refusals reject before launch, AX, screenshots, or input.
	*/
	async select(agent, client, handle, identity, signal) {
		await this.withOperation(agent, client, identity, signal, (signal) => this.selectInOrder(agent, identity.id, async () => {
			signal.throwIfAborted();
			const existing = this.clients.get(client)?.handles.get(handle);
			if (!client.disposed && existing && this.permitted(existing)) return;
			const saved = identity.persistable && this.options.grants().some((grant) => grant.id === identity.id);
			let scope = "persistent";
			if (!saved && this.rejected.get(agent)?.has(identity.id)) throw this.denied(identity);
			if (client.disposed) throw new NativeError("NATIVE_CLOSED", "Helper is closed; acquire fresh application handles");
			if (!saved) {
				const questions = this.ctx.get("userQuestions");
				if (!questions) throw new NativeError("APP_APPROVAL_UNAVAILABLE", "No human answerer is available for application access");
				const options = [{ label: "Allow for this task" }, { label: "Deny" }];
				if (identity.persistable && this.options.save) options.push({ label: "Always allow" });
				let result;
				try {
					result = await questions.ask({
						agent,
						signal,
						questions: [{
							id: "cua-app-access",
							question: `Allow Computer Use to launch if needed, read, capture, and control ${identity.name}?`,
							detail: `Application: ${identity.executablePath}\nTask access applies to the selected application instance, including its launch if needed. macOS permissions and approval of sensitive actions remain separate. Saved access can be revoked by removing its allowedApps entry from this provider configuration. Task access ends with the task.`,
							options
						}]
					});
				} catch (error) {
					if (error instanceof UserQuestionError && error.code === "ASK_CANCELLED") {
						this.invalidate(identity.id, agent);
						throw this.denied(identity);
					}
					if (error instanceof UserQuestionError && error.code === "DELEGATED_CALLER") throw new NativeError("APP_APPROVAL_UNAVAILABLE", "Application approval is unavailable in delegated tasks; ask the main task to perform this operation");
					throw error;
				}
				signal.throwIfAborted();
				const answer = result.answers.find((answer) => answer.id === "cua-app-access");
				const chosen = answer && !answer.custom?.trim() && answer.selected.length === 1 ? answer.selected[0] : void 0;
				if (chosen === "Allow for this task") scope = "task";
				else if (chosen === "Always allow" && identity.persistable && this.options.save) {
					const { persistable: _persistable, ...grant } = identity;
					await this.persist((grants) => {
						signal.throwIfAborted();
						return [...grants.filter((item) => item.id !== identity.id), grant];
					});
				} else {
					this.invalidate(identity.id, agent);
					throw this.denied(identity);
				}
			}
			signal.throwIfAborted();
			if (client.disposed) throw new NativeError("NATIVE_CLOSED", "Helper is closed; acquire fresh application handles");
			const state = this.clients.get(client) ?? {
				agent,
				handles: /* @__PURE__ */ new Map()
			};
			const { persistable: _persistable, ...grant } = identity;
			for (const [previous, previousState] of this.clients) if (previousState.agent === agent && previous !== client) {
				for (const selected of previousState.handles.values()) selected.lifetime.abort();
				this.clients.delete(previous);
			}
			state.handles.set(handle, {
				identity: grant,
				scope,
				lifetime: new AbortController()
			});
			this.clients.set(client, state);
			this.rejected.get(agent)?.delete(identity.id);
		}));
	}
	/**
	* Enforce live consent at the operation that dispatches native work.
	* @param client Helper owning the application handle.
	* @param handle Selected application.
	* @param signal Calling tool lifetime.
	* @param dispatch One native operation, with revocation cancellation.
	* @returns The native result, with no implicit retry after consent or cancellation.
	*/
	async run(client, handle, signal, dispatch) {
		const state = this.clients.get(client);
		const selected = state?.handles.get(handle);
		if (!state || !selected) throw new NativeError("APP_ACCESS_REQUIRED", "Select the application with getApp and obtain user consent before reading or controlling it");
		if (!this.permitted(selected)) {
			if (!selected.lifetime.signal.aborted) this.invalidate(selected.identity.id, state.agent);
			throw new NativeError("APP_ACCESS_REVOKED", "Application access was revoked; stop using this application");
		}
		if (client.disposed) throw new NativeError("NATIVE_CLOSED", "Helper is closed; acquire fresh application handles");
		return this.withOperation(state.agent, client, selected.identity, AbortSignal.any([signal, selected.lifetime.signal]), dispatch);
	}
	async selectInOrder(agent, id, select) {
		const selections = this.selections.get(agent) ?? /* @__PURE__ */ new Map();
		this.selections.set(agent, selections);
		const operation = (selections.get(id) ?? Promise.resolve()).then(select, select);
		selections.set(id, operation);
		try {
			await operation;
		} finally {
			if (selections.get(id) === operation) selections.delete(id);
		}
	}
	async withOperation(agent, client, identity, signal, dispatch) {
		const operation = {
			agent,
			client,
			identity,
			controller: new AbortController(),
			done: Promise.withResolvers()
		};
		this.active.add(operation);
		const lifetime = AbortSignal.any([
			signal,
			this.lifetime.signal,
			operation.controller.signal
		]);
		try {
			lifetime.throwIfAborted();
			const result = await dispatch(lifetime);
			lifetime.throwIfAborted();
			return result;
		} finally {
			this.active.delete(operation);
			operation.done.resolve();
		}
	}
	/**
	* Forget the disposed task's transient decisions and selected handles.
	* @param agent Disposed task whose transient decisions are released.
	*/
	forget(agent) {
		for (const [client, state] of this.clients) if (state.agent === agent) this.clients.delete(client);
		this.rejected.delete(agent);
	}
	permitted(selection) {
		return !selection.lifetime.signal.aborted && (selection.scope === "task" || this.options.grants().some((grant) => grant.id === selection.identity.id));
	}
	denied(identity) {
		return new NativeError("APP_ACCESS_DENIED", `The user denied access to ${identity.name}. Do not retry or use another tool to bypass this decision.`);
	}
	reject(agent, identity) {
		const rejected = this.rejected.get(agent) ?? /* @__PURE__ */ new Map();
		rejected.set(identity.id, {
			id: identity.id,
			name: identity.name,
			executablePath: identity.executablePath
		});
		this.rejected.set(agent, rejected);
	}
	invalidate(id, agent) {
		const clients = /* @__PURE__ */ new Set();
		for (const [client, state] of this.clients) for (const [handle, selection] of state.handles) if (selection.identity.id === id && (agent === void 0 || state.agent === agent)) {
			this.options.onInvalidate?.(state.agent, handle);
			selection.lifetime.abort(new NativeError("APP_ACCESS_REVOKED", "Application access was revoked; stop using this application"));
			this.reject(state.agent, selection.identity);
			clients.add(client);
		}
		for (const operation of this.active) if (operation.identity.id === id && (agent === void 0 || operation.agent === agent)) {
			this.reject(operation.agent, operation.identity);
			operation.controller.abort(this.denied(operation.identity));
			clients.add(operation.client);
		}
		for (const client of clients) client.invalidate();
	}
	reconcile() {
		for (const state of this.clients.values()) for (const selection of state.handles.values()) if (!selection.lifetime.signal.aborted && !this.permitted(selection)) this.invalidate(selection.identity.id);
	}
	persist(update) {
		return this.mutate(async () => {
			const save = this.options.save;
			if (!save) throw new Error("Application permissions cannot be saved in this composition");
			await save(update(this.options.grants()));
		});
	}
	mutate(mutate) {
		const perform = async () => {
			this.lifetime.signal.throwIfAborted();
			await mutate();
		};
		const operation = this.mutationTail.then(perform, perform);
		this.mutationTail = operation;
		return operation;
	}
};
//#endregion
//#region lib/types/protocol.js
/** JSON validation shared by model tool admission and the native object facade. */
const id = z.number().int().positive().max(2 ** 32 - 1);
const pid = z.number().int().positive().max(2 ** 31 - 1);
const point = z.number().nonnegative();
const relativePoint = z.number().int().min(0).max(1e3);
const app = { appHandle: z.string().min(1) };
const pointer = {
	mouseButton: z.enum([
		"left",
		"right",
		"middle"
	]).optional(),
	modifiers: z.array(z.enum([
		"command",
		"control",
		"option",
		"shift",
		"fn"
	])).optional()
};
const window = {
	...app,
	windowId: id
};
const snapshot = {
	...app,
	snapshotId: z.string().min(1),
	elementIndex: z.number().int().nonnegative()
};
const coordinate = {
	...window,
	snapshotId: z.string().min(1).optional(),
	x: point,
	y: point
};
const absoluteCoordinate = {
	...coordinate,
	relative: z.literal(false).optional().describe("Omitted or false uses pixels in the latest screenshot returned by this tool.")
};
const relativeCoordinate = {
	...coordinate,
	relative: z.literal(true).describe("Use integer thousandths of the window width and height, from 0 to 1000."),
	x: relativePoint,
	y: relativePoint
};
const bounds = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number().nonnegative(),
	height: z.number().nonnegative()
});
const operation = (method, params) => z.object({
	method: z.literal(method),
	params: z.object(params).strict()
}).strict();
const imageBase64 = z.string().min(1).refine((value) => Buffer$1.from(value, "base64").toString("base64") === value, { message: "Expected canonical base64 image data" });
/** Model-submittable operation parameters; Host resource fields and private continuations are separate. */
const Request = z.discriminatedUnion("method", [
	operation("getCapabilities", {}),
	operation("listApps", {}),
	operation("findApps", { query: z.string().min(1, "Expected a non-empty search string").regex(/\S/, "Expected a non-empty search string") }),
	operation("getApp", { selector: z.string().min(1) }),
	operation("activate", app),
	operation("show", {
		...app,
		windowId: id.optional()
	}),
	operation("listWindows", app),
	operation("getState", {
		...app,
		windowId: id.optional(),
		includeMenus: z.boolean().optional().describe("Expand menu contents; omitted or false shows menu-bar entries only."),
		details: z.boolean().optional().describe("Include identifiers, global-point bounds and complete action names.")
	}),
	z.object({
		method: z.literal("hover"),
		params: z.union([
			z.object(snapshot).strict(),
			z.object(absoluteCoordinate).strict(),
			z.object(relativeCoordinate).strict()
		])
	}).strict(),
	z.object({
		method: z.literal("click"),
		params: z.union([
			z.object({
				...snapshot,
				...pointer,
				clickCount: z.union([z.literal(1), z.literal(2)]).optional()
			}).strict(),
			z.object({
				...absoluteCoordinate,
				...pointer,
				clickCount: z.union([z.literal(1), z.literal(2)]).optional()
			}).strict(),
			z.object({
				...relativeCoordinate,
				...pointer,
				clickCount: z.union([z.literal(1), z.literal(2)]).optional()
			}).strict()
		])
	}).strict(),
	operation("setValue", {
		...snapshot,
		value: z.string()
	}),
	operation("selectText", {
		...snapshot,
		text: z.string().min(1),
		prefix: z.string().optional(),
		suffix: z.string().optional(),
		selectionType: z.enum([
			"text",
			"cursor_before",
			"cursor_after"
		]).optional()
	}),
	operation("performSecondaryAction", {
		...snapshot,
		action: z.string().min(1)
	}),
	operation("typeText", {
		...app,
		text: z.string()
	}),
	operation("paste", {
		...app,
		text: z.string(),
		format: z.enum(["text", "html"]).optional()
	}),
	operation("pressKey", {
		...app,
		key: z.string().min(1),
		modifiers: z.array(z.enum([
			"command",
			"control",
			"option",
			"shift",
			"fn"
		])).optional()
	}),
	z.object({
		method: z.literal("scroll"),
		params: z.union([z.object({
			...absoluteCoordinate,
			deltaLinesX: z.number().int().min(-10).max(10),
			deltaLinesY: z.number().int().min(-10).max(10)
		}).strict(), z.object({
			...relativeCoordinate,
			deltaLinesX: z.number().int().min(-10).max(10),
			deltaLinesY: z.number().int().min(-10).max(10)
		}).strict()])
	}).strict(),
	z.object({
		method: z.literal("drag"),
		params: z.union([z.object({
			...window,
			...pointer,
			snapshotId: z.string().min(1).optional(),
			relative: z.literal(false).optional(),
			fromX: point,
			fromY: point,
			toX: point,
			toY: point
		}).strict(), z.object({
			...window,
			...pointer,
			snapshotId: z.string().min(1).optional(),
			relative: z.literal(true),
			fromX: relativePoint,
			fromY: relativePoint,
			toX: relativePoint,
			toY: relativePoint
		}).strict()])
	}).strict(),
	operation("screenshot", window)
]);
z.object({
	maxElements: z.number().int().min(1).max(1e4),
	maxDepth: z.number().int().min(1).max(100)
}).strict(), z.object({
	durationMs: z.number().int().min(1).max(5e3),
	steps: z.number().int().min(1).max(240)
}).strict(), z.object({
	maxClipboardBytes: z.number().int().min(1024),
	pasteReadTimeoutMs: z.number().int().min(1).max(2 ** 31 - 1),
	maxElements: z.number().int().min(1).max(1e4),
	maxDepth: z.number().int().min(1).max(100)
}).strict(), z.object({ maxAppMatches: z.number().int().min(1).max(1e3) }).strict();
operation("launchApp", app);
/** Process identity returned only after a successful app selection. */
const AppResult = z.object({
	appHandle: z.string().min(1).transform((value) => value),
	pid,
	name: z.string(),
	bundleId: z.string().optional()
});
z.array(z.object({
	pid,
	name: z.string(),
	bundleId: z.string().optional()
}));
z.array(z.intersection(z.object({
	id: z.string().min(1),
	displayName: z.string(),
	path: z.string().min(1)
}), z.discriminatedUnion("isRunning", [z.object({
	isRunning: z.literal(true),
	pid
}), z.object({ isRunning: z.literal(false) })])));
/** Current windows and their global point bounds. */
const WindowsResult = z.array(z.object({
	windowId: id,
	pid,
	appName: z.string(),
	title: z.string(),
	bounds,
	isOnScreen: z.boolean(),
	onCurrentSpace: z.boolean().nullable()
}));
/** Observed state with window and process identity for stale-target rejection. */
const StateResult = z.object({
	appHandle: z.string().min(1).transform((value) => value),
	pid,
	windowId: id.nullable(),
	focusedWindowId: id.nullable().optional(),
	snapshotId: z.string().min(1).transform((value) => value),
	tree: z.string(),
	windows: WindowsResult,
	truncated: z.boolean()
});
/** Original native PNG and window-point geometry before Host image preparation. */
const NativeScreenshotResult = z.object({
	mimeType: z.literal("image/png"),
	data: imageBase64,
	pixelWidth: id,
	pixelHeight: id,
	windowId: id,
	bounds: bounds.extend({
		width: z.number().positive(),
		height: z.number().positive()
	}),
	coordinateSpace: z.literal("window-points")
});
NativeScreenshotResult.extend({
	mimeType: z.enum([
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif"
	]),
	coordinateSpace: z.literal("screenshot-pixels")
});
z.object({
	platform: z.string(),
	permissions: z.object({
		accessibility: z.boolean(),
		screenRecording: z.boolean()
	}),
	sessionLocked: z.boolean().nullable(),
	methods: z.array(z.string()),
	coordinateSpace: z.literal("screenshot-pixels"),
	browser: z.literal(false)
});
/** An action has reached native dispatch; application state was not verified. */
const ActionResult = z.object({
	dispatched: z.literal(true),
	verified: z.literal(false)
});
ActionResult.extend({
	hoverRoute: z.enum(["accessibility", "system-pointer"]),
	systemPointerMoved: z.boolean()
});
ActionResult.extend({
	windowId: id.nullable(),
	foregroundChanged: z.boolean().nullable()
});
//#endregion
//#region lib/types/coordinates.js
/** Tracks only the current window geometry and last successfully prepared screenshot. */
var CuaCoordinates = class {
	applications = /* @__PURE__ */ new Map();
	/**
	* Invalidate screenshot mappings when a window closes or changes size.
	* @param appHandle - native application selection.
	* @param windows - freshly observed windows.
	* @param windowId - selected window for a scoped observation; omission means a complete application inventory.
	*/
	observe(appHandle, windows, windowId) {
		const previous = this.applications.get(appHandle);
		const current = new Map(windowId === void 0 ? [] : previous);
		if (windowId !== void 0 && !windows.some((window) => window.windowId === windowId)) current.delete(windowId);
		for (const window of windows) {
			const { width, height } = window.bounds;
			const old = previous?.get(window.windowId);
			current.set(window.windowId, old?.width === width && old.height === height ? old : {
				width,
				height
			});
		}
		this.applications.set(appHandle, current);
	}
	/**
	* Bind the exact image delivered to the model to its native window size.
	* @param appHandle - native application selection.
	* @param windowId - selected native window.
	* @param bounds - capture-time window size in points.
	* @param image - encoded model-request image dimensions.
	*/
	screenshot(appHandle, windowId, bounds, image) {
		let frames = this.applications.get(appHandle);
		if (!frames) {
			frames = /* @__PURE__ */ new Map();
			this.applications.set(appHandle, frames);
		}
		frames.set(windowId, {
			width: bounds.width,
			height: bounds.height,
			image: {
				width: image.width,
				height: image.height
			}
		});
	}
	/**
	* Convert admitted coordinate arguments once, before native dispatch.
	* @param request - model request already checked by the operation schema.
	* @returns native parameters with Host-only coordinate options removed.
	*/
	parameters(request) {
		const params = request.params;
		const native = z.record(z.string(), z.json()).parse(params);
		if (!("x" in params) && !("fromX" in params)) return native;
		const frame = this.applications.get(params.appHandle)?.get(params.windowId);
		if (!frame || frame.width <= 0 || frame.height <= 0) throw new NativeError("STALE_SNAPSHOT", "Read fresh window state before coordinate input");
		const relative = params.relative === true;
		if (!relative && !frame.image) throw new NativeError("SCREENSHOT_REQUIRED", "Take a fresh screenshot before using absolute pixel coordinates");
		const convert = (value, axis) => {
			const pixels = frame.image?.[axis] ?? frame[axis];
			if (relative) return Math.min(value / 1e3 * frame[axis], Math.max(0, frame[axis] - 1));
			if (value >= pixels) throw new NativeError("INVALID_ARGUMENT", "Coordinate is outside the latest screenshot");
			return value * frame[axis] / pixels;
		};
		delete native.relative;
		if ("x" in params) {
			native.x = convert(params.x, "width");
			native.y = convert(params.y, "height");
		} else {
			native.fromX = convert(params.fromX, "width");
			native.fromY = convert(params.fromY, "height");
			native.toX = convert(params.toX, "width");
			native.toY = convert(params.toY, "height");
		}
		return native;
	}
};
//#endregion
//#region lib/types/index.js
/** Shared CUA tool execution, application consent, and object-runtime integration. */
/** Validated host configuration; no driver is downloaded at runtime. */
const CuaConfig = Schema.object({
	allowedApps: Schema.array(Schema.object({
		id: Schema.string().pattern(/^[a-f0-9]{64}$/).required(),
		name: Schema.string().required(),
		executablePath: Schema.string().min(1).required()
	})).default([]).volatile(),
	helperPath: Schema.string(),
	buildTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3e5),
	timeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3e4),
	connectTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5e3),
	screenshotTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5e3),
	axTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3e3),
	maxAppMatches: Schema.number().step(1).min(1).max(1e3).default(20),
	maxClipboardBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
	pasteReadTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(1e3),
	maxRequestBytes: Schema.number().step(1).min(1024).default(1024 * 1024),
	dragDurationMs: Schema.number().step(1).min(1).max(5e3).default(400),
	dragSteps: Schema.number().step(1).min(1).max(240).default(20),
	maxResponseBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
	textEventIntervalMs: Schema.number().min(0).max(1e3).default(.25),
	graceMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3e3),
	maxElements: Schema.number().step(1).min(1).max(1e4).default(2e3),
	maxDepth: Schema.number().step(1).min(1).max(100).default(25)
});
function executionAgent(execution) {
	if (!execution.agent) throw new Error("dsh-cua requires an agent-owned execution");
	return execution.agent;
}
/** Native values stay available to programs; only metadata and the stored image enter model content. */
function renderResult(args, value) {
	if (args.method !== "screenshot") return [{
		type: "text",
		text: JSON.stringify(value)
	}];
	const { data: _data, mimeType: _mimeType, attachment, ...metadata } = value;
	return [{
		type: "text",
		text: JSON.stringify(metadata)
	}, {
		type: "image",
		attachment
	}];
}
/** Resolve the exact calling model and attachment store before requesting a screenshot. */
async function screenshotStore(ctx, execution) {
	const attachments = ctx.get("attachments");
	if (!attachments) throw new Error("CUA screenshots require an attachment store");
	const agent = execution.agent;
	const routed = agent.session.requestHeader()?.config;
	const provider = routed?.provider ?? agent.options.provider;
	const model = routed?.model ?? agent.options.model;
	const llm = ctx.get("llm");
	if (provider === void 0 || model === void 0 || llm === void 0) throw new Error("CUA screenshot model route could not be resolved");
	const info = await llm.resolveModelInfo(provider, model, execution.signal);
	execution.signal.throwIfAborted();
	if (!info.inputModalities?.includes("image")) throw new Error(`CUA screenshots require model "${model}" to declare image input`);
	return {
		attachments,
		target: (image) => llm.imageRequestTarget(provider, model, image)
	};
}
/**
* Install authorized CUA calls and Agent-owned native connections.
* @param ctx - Provider context with computer-use, subprocess, tools, prompt, and Agent services.
* @param config - Validated resource limits and live application grants.
* @param backend - Platform-owned executable, connection factory, and instructions.
*/
function installCua(ctx, config, backend) {
	const { helperPath } = backend;
	const native = {
		helperPath,
		cwd: process.cwd(),
		timeoutMs: config.timeoutMs,
		axTimeoutMs: config.axTimeoutMs,
		connectTimeoutMs: config.connectTimeoutMs,
		screenshotTimeoutMs: config.screenshotTimeoutMs,
		maxRequestBytes: config.maxRequestBytes,
		maxResponseBytes: config.maxResponseBytes,
		graceMs: config.graceMs,
		textEventIntervalMs: config.textEventIntervalMs
	};
	const entryId = ctx.fiber.entry?.options.id;
	ctx.inject(["settings"], (scope) => scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)));
	const access = new ApplicationAccess(ctx, {
		onVolatile: backend.onVolatile,
		onInvalidate: (agent, handle) => backend.onRevoke?.(agent, handle),
		grants: () => config.allowedApps.get().map((grant) => ({
			...grant,
			id: grant.id
		})),
		get save() {
			const settings = ctx.get("settings");
			if (entryId === void 0 || settings === void 0) return void 0;
			const descriptor = settings.describe().find((entry) => entry.ns === entryId);
			if (!descriptor) return void 0;
			return async (grants) => {
				await settings.mutate(entryId, [{
					op: "set",
					path: ["allowedApps"],
					value: grants
				}], descriptor.revision);
			};
		}
	});
	const clients = /* @__PURE__ */ new Map();
	const lifetime = new AbortController();
	const pending = /* @__PURE__ */ new Map();
	const ownerCleanups = /* @__PURE__ */ new Map();
	const previewTasks = new Map();
	const busyOwners = new Map();
	const closedOwners = /* @__PURE__ */ new WeakSet();
	function ownerFor(agent) {
		if (closedOwners.has(agent) || ctx.agents.get(agent.id) !== agent) throw new Error("dsh-cua agent has been disposed");
		const existing = ownerCleanups.get(agent);
		if (existing) return existing;
		const controller = new AbortController();
		let closing;
		const close = () => {
			closedOwners.add(agent);
			controller.abort();
			return closing ??= Promise.resolve().then(async () => {
				try {
					await clients.get(agent)?.dispose();
				} finally {
					await Promise.allSettled([...pending].filter(([, owner]) => owner === agent).map(([task]) => task));
					clients.delete(agent);
					access.forget(agent);
					ownerCleanups.delete(agent);
				}
			});
		};
		const owner = {
			close,
			release: agent.ctx.effect(() => close, "dsh-cua.agent"),
			signal: controller.signal,
			coordinates: new CuaCoordinates()
		};
		ownerCleanups.set(agent, owner);
		return owner;
	}
	ctx.effect(function* () {
		yield ctx.computerUse.register(ComputerUseProviderName("dsh-cua"));
		yield async () => {
			lifetime.abort();
			const permissions = Promise.allSettled([access.dispose()]);
			await Promise.allSettled(pending.keys());
			const owners = [...ownerCleanups.values()];
			const results = await Promise.allSettled(owners.map((owner) => owner.close()));
			const releases = await Promise.allSettled(owners.map((owner) => owner.release()));
			const errors = [];
			for (const result of [
				...await permissions,
				...results,
				...releases
			]) if (result.status === "rejected") errors.push(result.reason);
			if (errors.length > 0) throw new AggregateError(errors, "dsh-cua helper cleanup failed");
		};
		const callNative = async (request, execution) => {
			const { method, params: parsedParams } = request;
			const params = execution.coordinates.parameters(request);
			const agent = execution.agent;
			const signal = execution.signal;
			signal.throwIfAborted();
			const client = execution.nativeClient;
			const nativeParams = method === "findApps" ? {
				...params,
				maxAppMatches: config.maxAppMatches
			} : method === "paste" ? {
				...params,
				maxClipboardBytes: config.maxClipboardBytes,
				pasteReadTimeoutMs: config.pasteReadTimeoutMs,
				maxElements: config.maxElements,
				maxDepth: config.maxDepth
			} : method === "getState" ? {
				...params,
				maxElements: config.maxElements,
				maxDepth: config.maxDepth
			} : method === "drag" ? {
				...params,
				durationMs: config.dragDurationMs,
				steps: config.dragSteps
			} : params;
			const requestNative = () => client.request(method, nativeParams, signal, execution.callId);
			if (method === "screenshot") {
				const { attachments, target } = await screenshotStore(ctx, execution);
				const screenshot = NativeScreenshotResult.parse(await requestNative());
				signal.throwIfAborted();
				const refs = await admitEncodedImages(attachments, [{
					data: screenshot.data,
					mediaType: screenshot.mimeType
				}]);
				signal.throwIfAborted();
				const attachment = refs[0];
				const original = attachment.originalDimensions ?? attachment;
				if (original.width !== screenshot.pixelWidth || original.height !== screenshot.pixelHeight) throw new NativeError("NATIVE_PROTOCOL", "Native screenshot dimensions disagree with its decoded image");
				const image = await attachments.readImageRequest(attachment, target(attachment), signal);
				signal.throwIfAborted();
				execution.coordinates.screenshot(parsedParams.appHandle, screenshot.windowId, screenshot.bounds, image);
				return {
					...screenshot,
					mimeType: image.mediaType,
					data: Buffer$1.from(image.data).toString("base64"),
					pixelWidth: image.width,
					pixelHeight: image.height,
					coordinateSpace: "screenshot-pixels",
					attachment
				};
			}
			const result = method === "paste" ? await withFileLock(join(tmpdir(), "dsh-cua-system-clipboard"), requestNative, {
				waitMs: config.timeoutMs,
				signal
			}) : await requestNative();
			if (method === "getApp") {
				const prepared = AppResult.extend({ pid: AppResult.shape.pid.nullable() }).parse(result);
				const { authorization } = z.object({ authorization: ApplicationAuthorizationResult }).parse(result);
				await access.select(agent, client, prepared.appHandle, authorization, signal);
				signal.throwIfAborted();
				const selected = prepared.pid === null ? AppResult.parse(await access.run(client, prepared.appHandle, signal, (signal) => client.request("launchApp", { appHandle: prepared.appHandle }, signal, execution.callId))) : AppResult.parse(prepared);
				if (selected.appHandle !== prepared.appHandle) throw new NativeError("NATIVE_PROTOCOL", "Launched application has another handle");
				return selected;
			}
			signal.throwIfAborted();
			if (method === "getCapabilities") return {
				...z.record(z.string(), z.json()).parse(result),
				coordinateSpace: "screenshot-pixels"
			};
			if (method === "getState") {
				const state = StateResult.parse(result);
				execution.coordinates.observe(state.appHandle, state.windows, state.windowId ?? void 0);
				return state;
			}
			if (method === "listWindows") execution.coordinates.observe(parsedParams.appHandle, WindowsResult.parse(result));
			return result;
		};
		yield ctx.tools.register({
			name: "cua",
			description: backend.description,
			parameters: {
				...z.record(z.string(), z.json()).parse(z.toJSONSchema(Request)),
				type: "object"
			},
			output: {
				schema: {},
				render: renderResult
			},
			async execute(args, execution) {
				let input = args;
				if (args && typeof args === "object" && !Array.isArray(args) && typeof args.params === "string") {
					let params;
					try { params = JSON.parse(args.params); } catch { throw new NativeError("INVALID_ARGUMENT", "params must be a JSON object"); }
					if (!params || typeof params !== "object" || Array.isArray(params)) throw new NativeError("INVALID_ARGUMENT", "params must be a JSON object");
					input = { ...args, params };
				}
				const request = Request.parse(input);
				const agent = executionAgent(execution);
				execution.signal.throwIfAborted();
				lifetime.signal.throwIfAborted();
				const owner = ownerFor(agent);
				busyOwners.set(agent, (busyOwners.get(agent) ?? 0) + 1);
				const previousPreview = previewTasks.get(agent);
				if (previousPreview) { previousPreview.controller.abort(); await Promise.allSettled([previousPreview.task]); }
				const signal = AbortSignal.any([
					execution.signal,
					lifetime.signal,
					owner.signal
				]);
				const operation = (async () => {
					const previous = clients.get(agent);
					if (previous?.disposed) await previous.dispose();
					signal.throwIfAborted();
					let client = clients.get(agent);
					if ("appHandle" in request.params && !client) throw new NativeError("APP_ACCESS_REQUIRED", "Select the application with getApp before reading or controlling it");
					if (!client || client.disposed && !("appHandle" in request.params)) {
						client = new NativeClient(ctx, native, backend.createChannel, (message) => {
							ctx.logger.debug(message);
						});
						clients.set(agent, client);
						owner.coordinates = new CuaCoordinates();
					}
					const nativeClient = client;
					const previewRequest = async (appHandle, method, params, previewSignal) => {
						if (busyOwners.has(agent) || previewTasks.has(agent)) throw new NativeError("NATIVE_BUSY", "Native preview is busy");
						const controller = new AbortController();
						const signal = AbortSignal.any([previewSignal, controller.signal, lifetime.signal, owner.signal]);
						signal.throwIfAborted();
						const task = access.run(nativeClient, appHandle, signal, async (authorizedSignal) => {
							const result = await nativeClient.request(method, { appHandle, ...params }, authorizedSignal);
							authorizedSignal.throwIfAborted();
							return method === "screenshot" ? NativeScreenshotResult.parse(result) : WindowsResult.parse(result);
						});
						previewTasks.set(agent, { controller, task });
						pending.set(task, agent);
						try { return await task; } finally { pending.delete(task); if (previewTasks.get(agent)?.task === task) previewTasks.delete(agent); }
					};
					backend.onClient?.(agent,
						(appHandle, windowId, signal) => previewRequest(appHandle, "screenshot", { windowId, displayOnly: true }, signal),
						(appHandle, signal) => previewRequest(appHandle, "listWindows", { displayOnly: true }, signal));
					const dispatch = async (signal) => {
						const result = await callNative(request, {
							...execution,
							agent,
							signal,
							nativeClient,
							coordinates: owner.coordinates
						});
						signal.throwIfAborted();
						return result;
					};
					return "appHandle" in request.params ? access.run(nativeClient, request.params.appHandle, signal, dispatch) : dispatch(signal);
				})();
				pending.set(operation, agent);
				try {
					return await operation;
				} finally {
					pending.delete(operation);
					const remaining = busyOwners.get(agent) - 1;
					if (remaining === 0) busyOwners.delete(agent); else busyOwners.set(agent, remaining);
				}
			}
		});
		yield ctx.systemPrompt.section({
			name: "computer-use:dsh-cua",
			order: ctx.systemPrompt.getSectionOrder("TOOL_COMPUTER_USE"),
			text: () => ctx.get("ptcRuntime")?.programFormat !== "repl" ? backend.guidance : `${backend.guidance}

Persistent PTC initialization:
var { connectCua } = await import(${JSON.stringify(import.meta.resolve("@deepseek-ai/dsh-cua/bridge"))});
var cua = connectCua(() => tools.cua, text => console.log(text));`
		});
	}, "dsh-cua.runtime");
}
//#endregion
export { CuaConfig, installCua };
