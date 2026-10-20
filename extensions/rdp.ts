/**
 * pi-rdp-computer-use
 *
 * Computer use over RDP for Wayland (and any other) desktops.
 *
 * The extension never touches X11, the Wayland screencast portal or uinput:
 * it drives a headless RDP client (bridge/rdp_bridge.py) that receives the
 * remote framebuffer as images for the model and sends mouse/keyboard events
 * back over the RDP wire.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = join(EXTENSION_DIR, "..", "bridge");

/** Python packages each bridge needs; `uv run --with` installs them on the fly. */
const BRIDGE_DEPS: Record<string, string[]> = {
	rdp: ["aardwolf", "pillow"],
	vnc: ["pillow", "pycryptodomex"],
};

function bridgeScript(protocol: string): string {
	return join(BRIDGE_DIR, protocol === "vnc" ? "vnc_bridge.py" : "rdp_bridge.py");
}
const CONFIG_PATH = join(homedir(), ".config", "pi-rdp-computer-use", "config.json");
const DEFAULT_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 120_000;
/** Ask the user for a decision for this long, then treat silence as a refusal. */
const CONSENT_TIMEOUT_MS = 180_000;
const CONSENT_DECLINED =
	"The user did not grant consent (declined or no answer within 3 minutes). Nothing was sent to the desktop.";

interface RdpConfig {
	/** "rdp" (default) or "vnc". Both expose the same tools. */
	protocol?: "rdp" | "vnc";
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	domain?: string;
	width?: number;
	height?: number;
	/** Python used to run the bridge. Defaults to `uv run --with aardwolf`. */
	python?: string;
	maxScreenshotWidth?: number;
	/** Ask the user before acting on their desktop. Default: actions gated, screenshots not. */
	consent?: {
		actions?: boolean;
		screenshots?: boolean;
		timeoutMs?: number;
	};
}

interface BridgeResponse {
	id: number | null;
	ok: boolean;
	result?: Record<string, unknown>;
	error?: string;
}

function loadConfig(): RdpConfig {
	const config: RdpConfig = {};
	if (existsSync(CONFIG_PATH)) {
		try {
			Object.assign(config, JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as RdpConfig);
		} catch {
			// A malformed config must not disable the extension.
		}
	}
	const env = process.env;
	if (env.PI_RDP_PROTOCOL === "rdp" || env.PI_RDP_PROTOCOL === "vnc") config.protocol = env.PI_RDP_PROTOCOL;
	if (env.RDP_HOST) config.host = env.RDP_HOST;
	if (env.RDP_PORT) config.port = Number(env.RDP_PORT);
	if (env.RDP_USERNAME) config.username = env.RDP_USERNAME;
	if (env.RDP_PASSWORD) config.password = env.RDP_PASSWORD;
	if (env.RDP_DOMAIN) config.domain = env.RDP_DOMAIN;
	if (env.PI_RDP_PYTHON) config.python = env.PI_RDP_PYTHON;
	return config;
}

/** Spawns and talks to the Python bridge over newline-delimited JSON. */
class Bridge {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private stderrLog: string[] = [];
	private config: RdpConfig;
	/** Bumped on every restart so a dying child's handlers cannot clobber the new one. */
	private generation = 0;

	constructor(config: RdpConfig) {
		this.config = config;
	}

	get protocol(): "rdp" | "vnc" {
		return this.config.protocol === "vnc" ? "vnc" : "rdp";
	}

	get script(): string {
		return bridgeScript(this.protocol);
	}

	/** Drop the process so the next call re-reads the config (protocol switch). */
	restart(): void {
		const old = this.child;
		this.child = undefined;
		this.buffer = "";
		this.generation += 1;
		if (this.pending.size > 0) {
			const reason = new Error("The desktop bridge was restarted; the request was cancelled.");
			for (const [, entry] of this.pending) entry.reject(reason);
			this.pending.clear();
		}
		old?.kill();
	}

	get running(): boolean {
		return this.child !== undefined && !this.child.killed;
	}

	recentStderr(): string {
		return this.stderrLog.slice(-15).join("\n");
	}

	private start(): void {
		if (this.running) return;
		const script = this.script;
		if (!existsSync(script)) {
			throw new Error(`Bridge script missing: ${script}`);
		}

		const explicitPython = this.config.python ?? process.env.PI_RDP_PYTHON;
		const command = explicitPython ?? "uv";
		const withArgs = (BRIDGE_DEPS[this.protocol] ?? []).flatMap((dep) => ["--with", dep]);
		const args = explicitPython
			? [script]
			: ["run", "--quiet", "--python", "3.13", ...withArgs, "--no-project", "--", "python", script];

		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PYTHONUNBUFFERED: "1" },
		}) as ChildProcessWithoutNullStreams;
		const generation = this.generation;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (generation !== this.generation) return;
			this.onStdout(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (generation !== this.generation) return;
			for (const line of chunk.split("\n")) {
				if (line.trim()) this.stderrLog.push(line.trim());
			}
			if (this.stderrLog.length > 200) this.stderrLog = this.stderrLog.slice(-100);
		});
		child.on("exit", (code) => {
			if (generation !== this.generation) return; // a restart replaced this child
			this.child = undefined;
			const reason = new Error(
				`Desktop bridge exited (code ${code ?? "null"}).${this.recentStderr() ? `\n${this.recentStderr()}` : ""}`,
			);
			for (const [, entry] of this.pending) entry.reject(reason);
			this.pending.clear();
		});
		child.on("error", (error) => {
			if (generation !== this.generation) return;
			this.child = undefined;
			for (const [, entry] of this.pending) entry.reject(new Error(`RDP bridge failed: ${error.message}`));
			this.pending.clear();
		});

		this.child = child;
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (line) this.onLine(line);
			index = this.buffer.indexOf("\n");
		}
	}

	private onLine(line: string): void {
		let response: BridgeResponse;
		try {
			response = JSON.parse(line) as BridgeResponse;
		} catch {
			return;
		}
		if (response.id === null || response.id === undefined) return;
		const entry = this.pending.get(response.id);
		if (!entry) return;
		this.pending.delete(response.id);
		if (response.ok) entry.resolve(response.result ?? {});
		else entry.reject(new Error(response.error ?? "Unknown bridge error"));
	}

	async call<T = Record<string, unknown>>(
		cmd: string,
		args: Record<string, unknown> = {},
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<T> {
		this.start();
		const id = this.nextId++;
		const payload = `${JSON.stringify({ id, cmd, args })}\n`;
		const child = this.child;
		if (!child) throw new Error("RDP bridge is not running");

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RDP bridge timed out after ${Math.round(timeoutMs / 1000)}s on '${cmd}'`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			child.stdin.write(payload);
		});
	}

	stop(): void {
		if (!this.child) return;
		this.child.kill("SIGTERM");
		this.child = undefined;
	}
}

function text(value: string) {
	return { type: "text" as const, text: value };
}

function image(pngBase64: string) {
	return { type: "image" as const, data: pngBase64, mimeType: "image/png" };
}

function screenshotContent(result: Record<string, unknown>) {
	const png = result.png_base64 as string;
	const width = result.width as number;
	const height = result.height as number;
	return {
		content: [image(png), text(`Remote desktop screenshot ${width}x${height}.`)],
		details: { width, height, bytes: result.bytes },
	};
}

export default function rdpComputerUse(pi: ExtensionAPI) {
	const config: RdpConfig = loadConfig();
	const bridge = new Bridge(config);

	pi.on("session_shutdown", () => {
		bridge.stop();
	});

	type ConsentUi = {
		ui: {
			confirm: (
				title: string,
				message: string,
				opts?: { timeout?: number; signal?: AbortSignal },
			) => Promise<boolean>;
		};
	};

	/**
	 * Ask the user before touching their desktop.
	 *
	 * Mirrors pi-ask-user-question: a dialog with a live countdown closes after
	 * CONSENT_TIMEOUT_MS, and an unanswered prompt counts as a refusal, so a
	 * forgotten prompt can never turn into unattended remote control.
	 *
	 * The dialog timeout is the primary mechanism; the AbortSignal timer is a
	 * backstop for any UI that does not honour it, so the gate always resolves.
	 */
	const requireConsent = async (ctx: ConsentUi, title: string, detail: string): Promise<void> => {
		const timeout = config.consent?.timeoutMs ?? CONSENT_TIMEOUT_MS;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(false);
			}, timeout);
		});
		let granted = false;
		try {
			granted = await Promise.race([
				ctx.ui.confirm(title, `${detail}\n\nAuto-declines in ${Math.round(timeout / 1000)}s.`, {
					timeout,
					signal: controller.signal,
				}),
				expired,
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (!granted) throw new Error(CONSENT_DECLINED);
	};

	const gate = async (ctx: ConsentUi, kind: "actions" | "screenshots", title: string, detail: string): Promise<void> => {
		const enabled = kind === "actions" ? (config.consent?.actions ?? true) : (config.consent?.screenshots ?? false);
		if (!enabled) return;
		await requireConsent(ctx, title, detail);
	};

	const resolveTarget = (params: { host?: string; port?: number }): { host: string; port: number } => {
		const host = params.host ?? config.host;
		if (!host) {
			throw new Error(
				`No RDP host configured. Pass host, set RDP_HOST, or create ${CONFIG_PATH} with {"host","username","password"}.`,
			);
		}
		const protocol = config.protocol === "vnc" ? "vnc" : "rdp";
	return { host, port: params.port ?? config.port ?? (protocol === "vnc" ? 5900 : 3389) };
	};

	pi.registerTool({
		name: "rdp_connect",
		label: "RDP Connect",
		description:
			"Open (or re-open) a desktop session (RDP or VNC, whichever the config selects) and wait for the first frame. Credentials come from parameters, RDP_USERNAME/RDP_PASSWORD, or the config file.",
		promptSnippet: "Connect to the desktop over RDP or VNC before taking screenshots or sending input",
		parameters: Type.Object({
			host: Type.Optional(Type.String({ description: "Desktop server host, e.g. 192.168.1.20 or localhost" })),
			port: Type.Optional(Type.Number({ description: "Server port (default 3389 for RDP, 5900 for VNC)" })),
			username: Type.Optional(Type.String({ description: "Account name on the remote desktop (RDP only)" })),
			password: Type.Optional(Type.String({ description: "Account password" })),
			domain: Type.Optional(Type.String({ description: "Optional NTLM domain" })),
			width: Type.Optional(Type.Number({ description: "Requested desktop width (default 1920)" })),
			height: Type.Optional(Type.Number({ description: "Requested desktop height (default 1080)" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			Object.assign(config, loadConfig());
			const protocol = config.protocol === "vnc" ? "vnc" : "rdp";
			await gate(ctx, "actions", "Allow remote desktop control?", `Pi wants to open a ${protocol.toUpperCase()} session.`);
			// Restart so a changed protocol/python setting takes effect.
			bridge.restart();
			const target = resolveTarget(params);
			const username = params.username ?? config.username;
			const password = params.password ?? config.password;
			if (protocol === "rdp" && !username) {
				throw new Error("Missing RDP username (parameter, RDP_USERNAME, or config file).");
			}
			if (password === undefined) throw new Error("Missing desktop password (parameter, RDP_PASSWORD, or config file).");

			const result = await bridge.call(
				"connect",
				{
					host: target.host,
					port: target.port,
					username: username ?? "",
					password,
					domain: params.domain ?? config.domain,
					width: params.width ?? config.width,
					height: params.height ?? config.height,
				},
				CONNECT_TIMEOUT_MS,
			);
			return {
				content: [
					text(
						`Connected to ${target.host}:${target.port} over ${protocol.toUpperCase()}` +
							`${username ? ` as ${username}` : ""}${result.frame_ready ? " (first frame received)" : ""}.`,
					),
				],
				details: { ...result, password: undefined },
			};
		},
	});

	pi.registerTool({
		name: "rdp_screenshot",
		label: "RDP Screenshot",
		description:
			"Capture the current remote desktop as an image so you can see the screen before deciding what to click or type.",
		promptSnippet: "Capture the remote desktop screen as an image",
		promptGuidelines: [
			"Call rdp_screenshot after every action that changes the screen, and read coordinates from the image before clicking.",
		],
		parameters: Type.Object({
			max_width: Type.Optional(
				Type.Number({ description: "Downscale the image so its width does not exceed this value" }),
			),
			allow_blank: Type.Optional(
				Type.Boolean({ description: "Return the frame even if the server has not painted yet" }),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await gate(ctx, "screenshots", "Allow a screenshot?", `Pi wants to capture a screenshot of your desktop.`);
			const result = await bridge.call("screenshot", {
				max_width: params.max_width ?? config.maxScreenshotWidth,
				allow_blank: params.allow_blank ?? false,
			});
			return screenshotContent(result);
		},
	});

	pi.registerTool({
		name: "rdp_click",
		label: "RDP Click",
		description: "Click a mouse button at pixel coordinates on the remote desktop.",
		promptSnippet: "Click at pixel coordinates on the remote desktop",
		parameters: Type.Object({
			x: Type.Number({ description: "Horizontal pixel coordinate" }),
			y: Type.Number({ description: "Vertical pixel coordinate" }),
			button: Type.Optional(
				Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
					description: "Mouse button (default left)",
				}),
			),
			clicks: Type.Optional(Type.Number({ description: "Number of clicks, 2 for a double click" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await gate(ctx, "actions", "Allow this click?", `Pi wants to click at (${params.x}, ${params.y}).`);
			const result = await bridge.call("click", {
				x: params.x,
				y: params.y,
				button: params.button ?? "left",
				clicks: params.clicks ?? 1,
			});
			return { content: [text(`Clicked ${params.button ?? "left"} at (${params.x}, ${params.y}).`)], details: result };
		},
	});

	pi.registerTool({
		name: "rdp_move",
		label: "RDP Move",
		description: "Move the pointer to pixel coordinates without clicking, e.g. to hover a menu open.",
		parameters: Type.Object({
			x: Type.Number({ description: "Horizontal pixel coordinate" }),
			y: Type.Number({ description: "Vertical pixel coordinate" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await gate(ctx, "actions", "Allow this pointer move?", `Pi wants to move the pointer to (${params.x}, ${params.y}).`);
			const result = await bridge.call("move", { x: params.x, y: params.y });
			return { content: [text(`Pointer moved to (${params.x}, ${params.y}).`)], details: result };
		},
	});

	pi.registerTool({
		name: "rdp_drag",
		label: "RDP Drag",
		description: "Press a mouse button at one point, drag to another, and release. Use for selections, sliders and window moves.",
		parameters: Type.Object({
			x1: Type.Number({ description: "Start x" }),
			y1: Type.Number({ description: "Start y" }),
			x2: Type.Number({ description: "End x" }),
			y2: Type.Number({ description: "End y" }),
			button: Type.Optional(
				Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
					description: "Mouse button (default left)",
				}),
			),
			steps: Type.Optional(Type.Number({ description: "Intermediate movement steps (default 12)" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await gate(ctx, "actions", "Allow this drag?", `Pi wants to drag from (${params.x1}, ${params.y1}) to (${params.x2}, ${params.y2}).`);
			const result = await bridge.call("drag", {
				x1: params.x1,
				y1: params.y1,
				x2: params.x2,
				y2: params.y2,
				button: params.button ?? "left",
				steps: params.steps ?? 12,
			});
			return {
				content: [
					text(`Dragged from (${params.x1}, ${params.y1}) to (${params.x2}, ${params.y2}) with the ${params.button ?? "left"} button.`),
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "rdp_scroll",
		label: "RDP Scroll",
		description: "Scroll the mouse wheel at a position on the remote desktop.",
		parameters: Type.Object({
			direction: Type.Optional(
				Type.Union([Type.Literal("up"), Type.Literal("down")], { description: "Wheel direction (default down)" }),
			),
			amount: Type.Optional(Type.Number({ description: "Wheel ticks (default 3)" })),
			x: Type.Optional(Type.Number({ description: "Pointer x for the scroll" })),
			y: Type.Optional(Type.Number({ description: "Pointer y for the scroll" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await gate(ctx, "actions", "Allow this scroll?", `Pi wants to scroll the desktop.`);
			const result = await bridge.call("scroll", {
				direction: params.direction ?? "down",
				amount: params.amount ?? 3,
				x: params.x,
				y: params.y,
			});
			return {
				content: [text(`Scrolled ${params.direction ?? "down"} ${params.amount ?? 3} ticks.`)],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "rdp_type",
		label: "RDP Type",
		description:
			"Type text into the focused window using Unicode key events (layout independent). Newlines press Enter.",
		parameters: Type.Object({
			text: Type.String({ description: "Text to type" }),
			interval: Type.Optional(Type.Number({ description: "Delay between keystrokes in seconds" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await gate(ctx, "actions", "Allow typing?", `Pi wants to type ${params.text.length} characters into the focused window.`);
			const result = await bridge.call("type", { text: params.text, interval: params.interval ?? 0.01 });
			return {
				content: [text(`Typed ${params.text.length} characters.`)],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "rdp_key",
		label: "RDP Key",
		description:
			"Press a named key or key combination, e.g. 'enter', 'tab', 'escape', 'f5', 'ctrl+c', 'alt+tab', 'super'.",
		parameters: Type.Object({
			key: Type.String({ description: "Key name or combination such as 'ctrl+c'" }),
			action: Type.Optional(
				Type.Union([Type.Literal("press"), Type.Literal("down"), Type.Literal("up")], {
					description: "press (default), or hold down/up separately",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await gate(ctx, "actions", "Allow this keypress?", `Pi wants to press ${params.key}.`);
			const result = await bridge.call("key", { key: params.key, action: params.action ?? "press" });
			return { content: [text(`Sent key ${params.key}.`)], details: result };
		},
	});

	pi.registerTool({
		name: "rdp_status",
		label: "RDP Status",
		description: "Report whether an RDP session is open, its geometry, uptime, and the last error.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const result = await bridge.call("status", {}, 20_000);
			return { content: [text(JSON.stringify(result, null, 2))], details: result };
		},
	});

	pi.registerTool({
		name: "rdp_disconnect",
		label: "RDP Disconnect",
		description: "Close the RDP session and stop the bridge process.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const result = await bridge.call("disconnect", {}, 30_000);
			bridge.stop();
			return { content: [text("RDP session closed.")], details: result };
		},
	});

	pi.registerCommand("rdp", {
		description: "RDP computer use: /rdp status | /rdp doctor | /rdp shot [path] | /rdp disconnect",
		handler: async (rawArgs, ctx) => {
			const [subcommand, ...rest] = rawArgs.trim().split(/\s+/);
			try {
				switch (subcommand) {
					case "status": {
						const status = await bridge.call("status", {}, 20_000);
						ctx.ui.notify(JSON.stringify(status), status.connected ? "info" : "warning");
						return;
					}
					case "doctor": {
						const doctor = await bridge.call("doctor", {}, 30_000);
						ctx.ui.notify(JSON.stringify(doctor, null, 2), "info");
						return;
					}
					case "shot": {
						const result = await bridge.call("screenshot", {}, 30_000);
						const target = rest[0] ?? join("/tmp", `rdp-shot-${Date.now()}.png`);
						const { writeFileSync } = await import("node:fs");
						writeFileSync(target, Buffer.from(result.png_base64 as string, "base64"));
						ctx.ui.notify(`Saved ${result.width}x${result.height} screenshot to ${target}`, "info");
						return;
					}
					case "disconnect": {
						await bridge.call("disconnect", {}, 30_000);
						bridge.stop();
						ctx.ui.notify("RDP session closed.", "info");
						return;
					}
					default:
						ctx.ui.notify("Usage: /rdp status | doctor | shot [path] | disconnect", "warning");
				}
			} catch (error) {
				ctx.ui.notify(`RDP: ${(error as Error).message}`, "error");
			}
		},
	});
}
