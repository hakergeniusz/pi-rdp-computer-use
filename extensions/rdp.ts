/**
 * pi-rdp-computer-use
 *
 * Full desktop control for Pi over RDP or VNC.
 *
 * The extension never touches X11, the Wayland screencast portal or uinput:
 * it drives a headless client (bridge/rdp_bridge.py or bridge/vnc_bridge.py)
 * that receives the remote framebuffer as images for the model and sends
 * mouse/keyboard events back over the wire.
 *
 * Tools (registered with `deferred` exposure, so Pi loads them on demand via
 * `tool_search` instead of spending context on every session):
 *
 *   rdp_connect     open a session and report the desktop geometry
 *   rdp_screenshot  full screen or a region, with the mouse cursor highlighted
 *   rdp_mouse       click (left/right/middle), move, drag, scroll
 *   rdp_keyboard    type text, press named keys and key combinations
 *   rdp_disconnect  close the session
 *   rdp_status      session state, geometry, last error
 *   rdp_clipboard   read the remote clipboard (VNC transport)
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** Every tool this extension owns, used to activate them when tool_search is absent. */
const TOOL_NAMES = [
	"rdp_connect",
	"rdp_screenshot",
	"rdp_mouse",
	"rdp_keyboard",
	"rdp_wait",
	"rdp_disconnect",
	"rdp_status",
	"rdp_clipboard",
];

const NAMESPACE = {
	name: "desktop",
	description:
		"Control a remote desktop: connect, capture the screen (full or a region with the cursor highlighted), click, scroll, type, disconnect.",
	instructions: [
		"Capture the screen with rdp_screenshot before acting, read pixel positions off the image,",
		"then act with rdp_mouse / rdp_keyboard. Coordinates are desktop pixels: a region capture",
		"reports the origin of the crop so image pixels can be converted to desktop pixels.",
		"Always rdp_disconnect when you are done with the desktop.",
	].join(" "),
};

type Protocol = "rdp" | "vnc";
type ConsentMode = "session" | "action" | "off";

interface RdpConfig {
	/** "rdp" (default) or "vnc". Both expose the same tools. */
	protocol?: Protocol;
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
	/** Ask the user before acting on their desktop. */
	consent?: {
		/** "session" (default, one prompt per session), "action" (every action) or "off". */
		mode?: ConsentMode;
		/** Legacy switch: false disables consent, true means "every action". */
		actions?: boolean;
		/** Also ask before taking screenshots. Default: false. */
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
	if (env.PI_RDP_CONSENT === "session" || env.PI_RDP_CONSENT === "action" || env.PI_RDP_CONSENT === "off") {
		config.consent = { ...config.consent, mode: env.PI_RDP_CONSENT };
	}
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

	get protocol(): Protocol {
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

	recentStderr(): string[] {
		return this.stderrLog.slice(-12);
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
		child.stdout.on("error", () => {}); // the exit handler cleans up pending calls
		child.stdout.on("data", (chunk: string) => {
			if (generation !== this.generation) return;
			this.onStdout(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("error", () => {});
		child.stderr.on("data", (chunk: string) => {
			if (generation !== this.generation) return;
			for (const line of chunk.split("\n")) {
				if (line.trim()) this.stderrLog.push(line.trim());
			}
			if (this.stderrLog.length > 200) this.stderrLog = this.stderrLog.slice(-100);
		});
		// A dead child rejects writes with EPIPE; without a handler Node raises
		// it as an unhandled 'error' event and the host process goes down.
		child.stdin.on("error", (error) => {
			if (generation !== this.generation) return;
			const reason = new Error(`Desktop bridge pipe failed: ${error.message}`);
			for (const [, entry] of this.pending) entry.reject(reason);
			this.pending.clear();
		});
		child.on("exit", (code) => {
			if (generation !== this.generation) return; // a restart replaced this child
			this.child = undefined;
			const reason = new Error(
				`Desktop bridge exited (code ${code ?? "null"}).${this.recentStderr().length ? `\n${this.recentStderr().join("\n")}` : ""}`,
			);
			for (const [, entry] of this.pending) entry.reject(reason);
			this.pending.clear();
		});
		child.on("error", (error) => {
			if (generation !== this.generation) return;
			this.child = undefined;
			for (const [, entry] of this.pending) entry.reject(new Error(`Desktop bridge failed: ${error.message}`));
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
		if (!child) throw new Error("Desktop bridge is not running");

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Desktop bridge timed out after ${Math.round(timeoutMs / 1000)}s on '${cmd}'`));
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
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		// Close stdin first: the bridge leaves its read loop, closes the socket
		// and lets the server tear the session down cleanly. Killing it
		// outright leaves the server with a half-open session, and
		// gnome-remote-desktop then refuses every new connection with
		// "Session creation inhibited" until the session ends.
		try {
			child.stdin.end();
		} catch {
			// The pipe may already be closed.
		}
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already gone.
			}
		}, 3000);
		timer.unref?.();
		child.once("exit", () => clearTimeout(timer));
	}
}

function text(value: string) {
	return { type: "text" as const, text: value };
}

function image(dataBase64: string, mimeType: string) {
	return { type: "image" as const, data: dataBase64, mimeType };
}

interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface CaptureInfo {
	region: Region | null;
	scale: number;
	desktop: { width: number; height: number } | null;
}

export default function rdpComputerUse(pi: ExtensionAPI) {
	const config: RdpConfig = loadConfig();
	const bridge = new Bridge(config);

	/** Credentials of the live session, so a dropped connection can be restored. */
	let liveConnection: {
		host: string;
		port: number;
		protocol: Protocol;
		username?: string;
		password?: string;
		domain?: string;
		width?: number;
		height?: number;
	} | null = null;
	/** Geometry of the last capture, used to map image pixels to desktop pixels. */
	let lastCapture: CaptureInfo | null = null;
	/** Whether the user already allowed this session to be controlled. */
	let sessionConsent = false;

	pi.on("session_shutdown", () => {
		bridge.stop();
	});

	// The desktop tools are deferred: Pi only declares them to the model once
	// tool_search finds them. If tool_search is not available in this session,
	// activate them directly so the extension is never a dead end.
	pi.on("session_start", () => {
		try {
			const all = pi.getAllTools();
			const active = pi.getActiveTools();
			const whitelist = pi.getSettings().defaultTools;
			const missing = TOOL_NAMES.filter((name) => !active.includes(name));
			if (whitelist && whitelist.length > 0) {
				// The user pinned the tool set: keep the desktop tools usable
				// without adding a discovery tool they did not ask for.
				if (missing.length) pi.setActiveTools([...active, ...missing]);
				return;
			}
			if (all.some((tool) => tool.name === "tool_search")) {
				if (!active.includes("tool_search")) pi.setActiveTools([...active, "tool_search"]);
				return;
			}
			if (missing.length) pi.setActiveTools([...active, ...missing]);
		} catch {
			// Never let activation bookkeeping break the session.
		}
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

	const consentMode = (): ConsentMode => {
		const configured = config.consent?.mode;
		if (configured === "session" || configured === "action" || configured === "off") return configured;
		// Legacy config: consent.actions === false used to disable the gate.
		if (config.consent?.actions === false) return "off";
		if (config.consent?.actions === true) return "action";
		return "session";
	};

	/**
	 * Ask the user before touching their desktop.
	 *
	 * A dialog with a live countdown closes after CONSENT_TIMEOUT_MS, and an
	 * unanswered prompt counts as a refusal, so a forgotten prompt can never
	 * turn into unattended remote control.
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

	/** Gate an action according to the configured consent mode. */
	const gate = async (
		ctx: ConsentUi,
		kind: "actions" | "screenshots",
		title: string,
		detail: string,
	): Promise<void> => {
		const mode = consentMode();
		if (mode === "off") return;
		if (kind === "screenshots") {
			if (!config.consent?.screenshots) return;
			await requireConsent(ctx, title, detail);
			return;
		}
		if (mode === "session") {
			if (sessionConsent) return;
			await requireConsent(ctx, title, detail);
			sessionConsent = true;
			return;
		}
		await requireConsent(ctx, title, detail);
	};

	const resolveTarget = (params: { host?: string; port?: number }): { host: string; port: number; explicitPort: boolean } => {
		const host = params.host ?? config.host;
		if (!host) {
			throw new Error(
				`No desktop host configured. Pass host, set RDP_HOST, or create ${CONFIG_PATH} with {"host","username","password"}.`,
			);
		}
		const protocol: Protocol = config.protocol === "vnc" ? "vnc" : "rdp";
		return {
			host,
			port: params.port ?? config.port ?? (protocol === "vnc" ? 5900 : 3389),
			explicitPort: params.port !== undefined || config.port !== undefined,
		};
	};

	/** Open a session, falling back to the other transport when the first fails. */
	const openSession = async (
		target: { host: string; port: number; explicitPort: boolean },
		credentials: {
			username?: string;
			password?: string;
			domain?: string;
			width?: number;
			height?: number;
		},
		requested?: Protocol,
	): Promise<{ result: Record<string, unknown>; protocol: Protocol; port: number }> => {
		const primary: Protocol = config.protocol === "vnc" ? "vnc" : "rdp";
		const order: Protocol[] = requested ? [requested] : primary === "rdp" ? ["rdp", "vnc"] : ["vnc", "rdp"];
		let lastError: unknown;
		for (const protocol of order) {
			// A fallback transport uses its own default port unless one was set explicitly.
			const port =
				protocol === primary || target.explicitPort
					? target.port
					: protocol === "vnc"
						? 5900
						: 3389;
			for (let attempt = 1; attempt <= 3; attempt += 1) {
				try {
					config.protocol = protocol;
					bridge.restart();
					const result = await bridge.call(
						"connect",
						{
							host: target.host,
							port,
							username: credentials.username ?? "",
							password: credentials.password ?? "",
							domain: credentials.domain,
							width: credentials.width,
							height: credentials.height,
						},
						CONNECT_TIMEOUT_MS,
					);
					return { result, protocol, port };
				} catch (error) {
					lastError = error;
					const message = error instanceof Error ? error.message : String(error);
					// The server may still be tearing down the previous session
					// ("Session creation inhibited"): wait and try again.
					const transient = /reset|inhibited|connection lost|refused|timed out/i.test(message);
					if (!transient || attempt === 3) break;
					await new Promise((resolve) => setTimeout(resolve, 4000 * attempt));
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	};

	/** Re-open the session after the bridge or the server dropped it. */
	const ensureSession = async (): Promise<void> => {
		if (!liveConnection) {
			throw new Error("No desktop session. Call rdp_connect first.");
		}
		await openSession(
			{ host: liveConnection.host, port: liveConnection.port, explicitPort: true },
			{
				username: liveConnection.username,
				password: liveConnection.password,
				domain: liveConnection.domain,
				width: liveConnection.width,
				height: liveConnection.height,
			},
			liveConnection.protocol,
		);
		lastCapture = null;
	};

	/** Run a bridge command, transparently reconnecting once if the session died. */
	const call = async <T = Record<string, unknown>>(
		cmd: string,
		args: Record<string, unknown> = {},
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<T> => {
		try {
			return await bridge.call<T>(cmd, args, timeoutMs);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const lost = /not connected|no desktop session|connection lost|bridge exited|bridge failed|pipe failed/i.test(
				message,
			);
			if (!lost || !liveConnection) throw error;
			await ensureSession();
			return bridge.call<T>(cmd, args, timeoutMs);
		}
	};

	const screenshotContent = (result: Record<string, unknown>) => {
		const data = result.image_base64 as string;
		const mimeType = (result.mime_type as string) ?? "image/png";
		const desktop = result.desktop as { width: number; height: number } | undefined;
		const region = (result.region as Region | null) ?? null;
		const scale = Number(result.scale ?? 1) || 1;
		const cursor = result.cursor as { x: number | null; y: number | null; visible: boolean } | undefined;
		const ocr = result.ocr_text as string | null | undefined;

		const lines: string[] = [];
		if (ocr) {
			lines.push(`Text on screen (OCR):\n${ocr}`);
		} else if (result.ocr_error) {
			lines.push(`OCR unavailable: ${result.ocr_error}`);
		}
		if (region) {
			lines.push(
				`Region ${region.width}x${region.height} of the ${desktop?.width}x${desktop?.height} desktop, origin at desktop (${region.x}, ${region.y}).`,
			);
			lines.push(
				`Image pixel (ix, iy) = desktop (${region.x} + ix/${scale}, ${region.y} + iy/${scale}). Use those desktop coordinates for rdp_mouse.`,
			);
		} else {
			lines.push(
				`Full desktop ${result.width}x${result.height}${scale !== 1 ? ` (downscaled from ${desktop?.width}x${desktop?.height}, scale ${scale})` : ""}.`,
			);
			lines.push(`Image pixel (ix, iy) = desktop (ix/${scale}, iy/${scale}).`);
		}
		if (cursor && cursor.x !== null && cursor.y !== null) {
			lines.push(
				cursor.visible
					? `Mouse cursor at desktop (${cursor.x}, ${cursor.y}), marked with a magenta crosshair.`
					: `Mouse cursor at desktop (${cursor.x}, ${cursor.y}), outside this capture.`,
			);
		}

		return {
			content: [image(data, mimeType), text(lines.join("\n"))],
			details: {
				width: result.width,
				height: result.height,
				bytes: result.bytes,
				desktop,
				region,
				scale,
				cursor,
			},
		};
	};

	/** Convert a coordinate pair from the model's space into desktop pixels. */
	const toDesktop = (
		x: number,
		y: number,
		space: "desktop" | "image",
	): { x: number; y: number; clamped: boolean } => {
		let desktopX = x;
		let desktopY = y;
		if (space === "image" && lastCapture) {
			const originX = lastCapture.region?.x ?? 0;
			const originY = lastCapture.region?.y ?? 0;
			desktopX = originX + x / (lastCapture.scale || 1);
			desktopY = originY + y / (lastCapture.scale || 1);
		}
		let clamped = false;
		const width = lastCapture?.desktop?.width;
		const height = lastCapture?.desktop?.height;
		if (width && desktopX >= width) {
			desktopX = width - 1;
			clamped = true;
		}
		if (height && desktopY >= height) {
			desktopY = height - 1;
			clamped = true;
		}
		if (desktopX < 0) {
			desktopX = 0;
			clamped = true;
		}
		if (desktopY < 0) {
			desktopY = 0;
			clamped = true;
		}
		return { x: Math.round(desktopX), y: Math.round(desktopY), clamped };
	};

	pi.registerTool({
		name: "rdp_connect",
		label: "Desktop Connect",
		description:
			"Open a remote desktop session (RDP or VNC) so the screen can be captured and the mouse and keyboard driven. " +
			"Returns the desktop size in pixels, which is the coordinate space for rdp_mouse.",
		promptSnippet: "Open a remote desktop session (RDP or VNC) for screen capture and input",
		parameters: Type.Object({
			host: Type.Optional(Type.String({ description: "Desktop server host, e.g. 192.168.1.20 or localhost" })),
			port: Type.Optional(Type.Number({ description: "Server port (default 3389 for RDP, 5900 for VNC)" })),
			protocol: Type.Optional(
				Type.Union([Type.Literal("rdp"), Type.Literal("vnc")], {
					description: "Transport to use. Default: the configured one, falling back to the other if it fails.",
				}),
			),
			username: Type.Optional(Type.String({ description: "Account name on the remote desktop (RDP only)" })),
			password: Type.Optional(Type.String({ description: "Account password (prefer RDP_PASSWORD or the config file)" })),
			domain: Type.Optional(Type.String({ description: "Optional NTLM domain" })),
			width: Type.Optional(Type.Number({ description: "Requested desktop width (default 1920)" })),
			height: Type.Optional(Type.Number({ description: "Requested desktop height (default 1080)" })),
		}),
		exposure: "deferred",
		namespace: NAMESPACE,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			Object.assign(config, loadConfig());
			const target = resolveTarget(params);
			const username = params.username ?? config.username;
			let password = params.password ?? config.password;
			const requested = params.protocol as Protocol | undefined;
			if (password === undefined) {
				// VNC servers may run without authentication (security type
				// "None"); RDP always needs credentials.
				const effective: Protocol = requested ?? (config.protocol === "vnc" ? "vnc" : "rdp");
				if (effective === "vnc") password = "";
				else throw new Error("Missing desktop password (parameter, RDP_PASSWORD, or the config file).");
			}

			await gate(
				ctx,
				"actions",
				"Allow remote desktop control?",
				`Pi wants to open a desktop session to ${target.host}:${target.port}.`,
			);

			const { result, protocol, port } = await openSession(
				target,
				{
					username,
					password,
					domain: params.domain ?? config.domain,
					width: params.width ?? config.width,
					height: params.height ?? config.height,
				},
				requested,
			);

			liveConnection = {
				host: target.host,
				port,
				protocol,
				username,
				password,
				domain: params.domain ?? config.domain,
				width: params.width ?? config.width,
				height: params.height ?? config.height,
			};
			sessionConsent = true;
			lastCapture = null;

			const desktop = result.desktop as { width: number; height: number } | undefined;
			return {
				content: [
					text(
						`Connected to ${target.host}:${port} over ${protocol.toUpperCase()}` +
							`${username ? ` as ${username}` : ""}. ` +
							(desktop
								? `The desktop is ${desktop.width}x${desktop.height} pixels; those are the coordinates rdp_mouse uses.`
								: "The desktop size is not known yet; take a screenshot to learn it."),
					),
				],
				details: { ...result, password: undefined, protocol },
			};
		},
	});

	pi.registerTool({
		name: "rdp_screenshot",
		label: "Desktop Screenshot",
		description:
			"Capture the remote desktop as an image: the whole screen, or just a region (part of the screen) by passing " +
			"region {x, y, width, height}. The mouse cursor is highlighted with a magenta crosshair. " +
			"The result states the crop origin and scale so image pixels can be converted to desktop pixels for rdp_mouse.",
		promptSnippet: "Capture the remote desktop screen, or a region of it, with the cursor highlighted",
		promptGuidelines: [
			"Take a screenshot before every decision that depends on what is on screen, and read pixel positions off the image.",
			"Use a region capture to look closely at a small area; the region origin is reported so coordinates stay convertible.",
		],
		parameters: Type.Object({
			region: Type.Optional(
				Type.Object(
					{
						x: Type.Number({ description: "Left edge in desktop pixels" }),
						y: Type.Number({ description: "Top edge in desktop pixels" }),
						width: Type.Number({ description: "Width in desktop pixels" }),
						height: Type.Number({ description: "Height in desktop pixels" }),
					},
					{ description: "Capture only this part of the screen. Omit for the full desktop." },
				),
			),
			mark_region: Type.Optional(
				Type.Object(
					{
						x: Type.Number({ description: "Left edge in desktop pixels" }),
						y: Type.Number({ description: "Top edge in desktop pixels" }),
						width: Type.Number({ description: "Width in desktop pixels" }),
						height: Type.Number({ description: "Height in desktop pixels" }),
					},
					{ description: "Outline this area on a full-desktop capture, to show where to look." },
				),
			),
			highlight_cursor: Type.Optional(
				Type.Boolean({ description: "Draw a magenta crosshair at the mouse cursor (default true)" }),
			),
			cursor_x: Type.Optional(Type.Number({ description: "Cursor x in desktop pixels, if it is known" })),
			cursor_y: Type.Optional(Type.Number({ description: "Cursor y in desktop pixels, if it is known" })),
			max_width: Type.Optional(Type.Number({ description: "Downscale so the image is at most this wide" })),
			max_height: Type.Optional(Type.Number({ description: "Downscale so the image is at most this tall" })),
			format: Type.Optional(
				Type.Union([Type.Literal("png"), Type.Literal("jpeg")], { description: "Image format (default png)" }),
			),
			quality: Type.Optional(Type.Number({ description: "JPEG quality, 20-95 (default 85)" })),
			ocr: Type.Optional(
				Type.Boolean({ description: "Also return the text on screen, read with tesseract" }),
			),
			ocr_lang: Type.Optional(Type.String({ description: "tesseract language, e.g. 'eng' (default)" })),
			full_refresh: Type.Optional(
					Type.Boolean({
						description:
							"Ask the VNC server for the whole framebuffer instead of only what changed (ignored on RDP)",
					}),
				),
			timeout: Type.Optional(Type.Number({ description: "Seconds to wait for a fresh frame (default 6)" })),
		}),
		exposure: "deferred",
		namespace: NAMESPACE,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await gate(ctx, "screenshots", "Allow a screenshot?", "Pi wants to capture a screenshot of your desktop.");
			const result = await call("screenshot", {
				region: params.region,
				mark_region: params.mark_region,
				highlight_cursor: params.highlight_cursor ?? true,
				cursor_x: params.cursor_x,
				cursor_y: params.cursor_y,
				max_width: params.max_width ?? config.maxScreenshotWidth,
				max_height: params.max_height,
				format: params.format ?? "png",
				quality: params.quality ?? 85,
				ocr: params.ocr ?? false,
				ocr_lang: params.ocr_lang ?? "eng",
				full_refresh: params.full_refresh ?? false,
				timeout: params.timeout ?? 6,
			});
			lastCapture = {
				region: (result.region as Region | null) ?? null,
				scale: Number(result.scale ?? 1) || 1,
				desktop: (result.desktop as { width: number; height: number }) ?? null,
			};
			return screenshotContent(result);
		},
	});

	pi.registerTool({
		name: "rdp_mouse",
		label: "Desktop Mouse",
		description:
			"Control the mouse on the remote desktop: left, right or middle click at any desktop pixel position, move the pointer, " +
			"drag from one point to another, press or release a held button, or scroll the wheel up, down, left or right. " +
			"Coordinates are desktop pixels, as reported by rdp_connect and rdp_screenshot.",
		promptSnippet: "Click, drag or scroll the mouse on the remote desktop",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("click"),
						Type.Literal("move"),
						Type.Literal("drag"),
						Type.Literal("scroll"),
						Type.Literal("down"),
						Type.Literal("up"),
					],
					{ description: "What to do (default click)" },
				),
			),
			x: Type.Optional(Type.Number({ description: "Desktop x pixel" })),
			y: Type.Optional(Type.Number({ description: "Desktop y pixel" })),
			button: Type.Optional(
				Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
					description: "Mouse button (default left)",
				}),
			),
			clicks: Type.Optional(Type.Number({ description: "Number of clicks, 2 for a double click" })),
			direction: Type.Optional(
					Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")], {
						description: "Scroll direction (default down). left/right need the VNC transport",
					}),
				),
			amount: Type.Optional(Type.Number({ description: "Scroll ticks (default 3)" })),
			x1: Type.Optional(Type.Number({ description: "Drag start x in desktop pixels" })),
			y1: Type.Optional(Type.Number({ description: "Drag start y in desktop pixels" })),
			x2: Type.Optional(Type.Number({ description: "Drag end x in desktop pixels" })),
			y2: Type.Optional(Type.Number({ description: "Drag end y in desktop pixels" })),
			space: Type.Optional(
				Type.Union([Type.Literal("desktop"), Type.Literal("image")], {
					description:
						"Coordinate space of x and y: 'desktop' pixels, or 'image' pixels of the last screenshot (default desktop)",
				}),
			),
			capture_after: Type.Optional(
				Type.Boolean({ description: "Return a fresh screenshot after the action" }),
			),
		}),
		exposure: "deferred",
		namespace: NAMESPACE,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const action = params.action ?? "click";
			const button = params.button ?? "left";
			const space = params.space ?? "desktop";
			const summary = (detail: string) => `Pi wants to ${detail} on the remote desktop.`;
			await gate(ctx, "actions", "Allow this mouse action?", summary(action));

			let result: Record<string, unknown> = {};
			let message = "";
			let clamped = false;

			if (action === "scroll") {
				const direction = params.direction ?? "down";
				const amount = params.amount ?? 3;
				if ((direction === "left" || direction === "right") && bridge.protocol === "rdp") {
					throw new Error("Horizontal scrolling needs the VNC transport; over RDP the wheel is vertical only.");
				}
				// Without an explicit position the bridge scrolls at the current pointer location.
				const at =
					params.x !== undefined && params.y !== undefined ? toDesktop(params.x, params.y, space) : null;
				clamped = at?.clamped ?? false;
				result = await call("scroll", {
					direction,
					amount,
					...(at ? { x: at.x, y: at.y } : {}),
				});
				message = at
					? `Scrolled ${direction} ${amount} tick(s) at (${at.x}, ${at.y}).`
					: `Scrolled ${direction} ${amount} tick(s).`;
			} else if (action === "drag") {
				if (params.x1 === undefined || params.y1 === undefined || params.x2 === undefined || params.y2 === undefined) {
					throw new Error("A drag needs x1, y1, x2 and y2.");
				}
				const from = toDesktop(params.x1, params.y1, space);
				const to = toDesktop(params.x2, params.y2, space);
				clamped = from.clamped || to.clamped;
				result = await call("drag", {
					x1: from.x,
					y1: from.y,
					x2: to.x,
					y2: to.y,
					button,
					steps: 12,
				});
				message = `Dragged the ${button} button from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).`;
			} else if (action === "move") {
				if (params.x === undefined || params.y === undefined) {
					throw new Error("A move needs x and y.");
				}
				const at = toDesktop(params.x, params.y, space);
				clamped = at.clamped;
				result = await call("move", { x: at.x, y: at.y });
				message = `Moved the pointer to (${at.x}, ${at.y}).`;
			} else if (action === "down" || action === "up") {
				if (params.x === undefined || params.y === undefined) {
					throw new Error(`${action} needs x and y.`);
				}
				const at = toDesktop(params.x, params.y, space);
				clamped = at.clamped;
				result = await call("button", { x: at.x, y: at.y, button, action });
				message = `${action === "down" ? "Pressed" : "Released"} the ${button} button at (${at.x}, ${at.y}).`;
			} else {
				if (params.x === undefined || params.y === undefined) {
					throw new Error("A click needs x and y.");
				}
				const at = toDesktop(params.x, params.y, space);
				clamped = at.clamped;
				result = await call("click", {
					x: at.x,
					y: at.y,
					button,
					clicks: params.clicks ?? 1,
				});
				message = `Clicked the ${button} button ${params.clicks ?? 1} time(s) at (${at.x}, ${at.y}).`;
			}
			if (clamped) {
				message += " The requested coordinates were outside the desktop; they were clamped to its bounds.";
			}

			if (params.capture_after) {
				const shot = await call("screenshot", { highlight_cursor: true, timeout: 6 });
				lastCapture = {
					region: (shot.region as Region | null) ?? null,
					scale: Number(shot.scale ?? 1) || 1,
					desktop: (shot.desktop as { width: number; height: number }) ?? null,
				};
				return {
					content: [image(shot.image_base64 as string, (shot.mime_type as string) ?? "image/png"), text(message)],
					details: { ...result, capture: { width: shot.width, height: shot.height } },
				};
			}

			return { content: [text(message)], details: result };
		},
	});

	pi.registerTool({
		name: "rdp_keyboard",
		label: "Desktop Keyboard",
		description:
			"Type text into the focused window on the remote desktop, or press a named key or key combination such as " +
			"'enter', 'tab', 'escape', 'f5', 'ctrl+c', 'ctrl+shift+t' or 'alt+tab'. Text is sent as Unicode key events, " +
			"so it works with any keyboard layout.",
		promptSnippet: "Type text or press keys on the remote desktop",
		parameters: Type.Object({
			text: Type.Optional(Type.String({ description: "Text to type. Newlines press Enter, tabs press Tab." })),
			key: Type.Optional(
				Type.String({ description: "Named key or combination, e.g. 'enter', 'escape', 'ctrl+c', 'alt+tab'" }),
			),
			action: Type.Optional(
				Type.Union([Type.Literal("press"), Type.Literal("down"), Type.Literal("up")], {
					description: "press (default), or hold down/up separately",
				}),
			),
			interval: Type.Optional(Type.Number({ description: "Delay between keystrokes in seconds (default 0.01)" })),
			capture_after: Type.Optional(Type.Boolean({ description: "Return a fresh screenshot after typing" })),
		}),
		exposure: "deferred",
		namespace: NAMESPACE,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.text === undefined && params.key === undefined) {
				throw new Error("Give text to type, a key to press, or both.");
			}
			await gate(
				ctx,
				"actions",
				"Allow typing?",
				params.text !== undefined
					? `Pi wants to type ${params.text.length} characters into the focused window.`
					: `Pi wants to press ${params.key}.`,
			);

			const parts: string[] = [];
			let result: Record<string, unknown> = {};
			if (params.text !== undefined) {
				result = await call("type", { text: params.text, interval: params.interval ?? 0.01 });
				parts.push(`Typed ${params.text.length} characters`);
			}
			if (params.key !== undefined) {
				result = await call("key", { key: params.key, action: params.action ?? "press" });
				parts.push(`pressed ${params.key}`);
			}

			if (params.capture_after) {
				const shot = await call("screenshot", { highlight_cursor: true, timeout: 6 });
				lastCapture = {
					region: (shot.region as Region | null) ?? null,
					scale: Number(shot.scale ?? 1) || 1,
					desktop: (shot.desktop as { width: number; height: number }) ?? null,
				};
				return {
					content: [image(shot.image_base64 as string, (shot.mime_type as string) ?? "image/png"), text(`${parts.join(", ")}.`)],
					details: { ...result, capture: { width: shot.width, height: shot.height } },
				};
			}

			return { content: [text(`${parts.join(", ")}.`)], details: result };
		},
	});

	pi.registerTool({
		name: "rdp_wait",
		label: "Desktop Wait",
		description:
			"Wait until the remote screen changes, or until the timeout expires. Use it after an action that should " +
			"trigger a UI update instead of sleeping blindly, so the agent continues as soon as the screen updates.",
		promptSnippet: "Wait until the remote screen changes",
		parameters: Type.Object({
			timeout: Type.Optional(Type.Number({ description: "Seconds to wait at most (default 10)" })),
			region: Type.Optional(
				Type.Object(
					{
						x: Type.Number({ description: "Left edge in desktop pixels" }),
						y: Type.Number({ description: "Top edge in desktop pixels" }),
						width: Type.Number({ description: "Width in desktop pixels" }),
						height: Type.Number({ description: "Height in desktop pixels" }),
					},
					{ description: "Only watch this part of the screen" },
				),
			),
		}),
		exposure: "deferred",
		namespace: NAMESPACE,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await gate(ctx, "screenshots", "Allow watching the screen?", "Pi wants to wait for the screen to change.");
			const result = await call(
				"wait",
				{ timeout: params.timeout ?? 10, region: params.region },
				Math.round((params.timeout ?? 10) * 1000) + 15_000,
			);
			const changed = Boolean(result.changed);
			return {
				content: [
					text(
						changed
							? `The screen changed after ${result.waited_ms} ms.`
							: `The screen did not change within ${params.timeout ?? 10} s.`,
					),
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "rdp_disconnect",
		label: "Desktop Disconnect",
		description: "Close the remote desktop session and stop the bridge process.",
		promptSnippet: "Close the remote desktop session",
		parameters: Type.Object({}),
		exposure: "deferred",
		namespace: NAMESPACE,
		executionMode: "sequential",
		async execute() {
			if (!liveConnection && !bridge.running) {
				return { content: [text("No desktop session was open.")], details: { connected: false } };
			}
			let result: Record<string, unknown> = { connected: false };
			try {
				result = await call("disconnect", {}, 30_000);
			} finally {
				bridge.stop();
				liveConnection = null;
				lastCapture = null;
				sessionConsent = false;
			}
			return { content: [text("Desktop session closed.")], details: result };
		},
	});

	pi.registerTool({
		name: "rdp_status",
		label: "Desktop Status",
		description:
			"Report the state of the remote desktop session: whether it is connected, which transport is in use, " +
			"the desktop size and the last error.",
		promptSnippet: "Check the remote desktop session state",
		parameters: Type.Object({}),
		exposure: "deferred",
		namespace: NAMESPACE,
		executionMode: "sequential",
		async execute() {
			if (!bridge.running) {
				// Do not spawn a bridge just to be told there is no session.
				const result = {
					connected: false,
					protocol: bridge.protocol,
					session: liveConnection
						? {
								host: liveConnection.host,
								port: liveConnection.port,
								protocol: liveConnection.protocol,
								note: "The bridge is not running; the next tool call reconnects with the stored credentials.",
							}
						: { note: "No session yet. Call rdp_connect." },
				};
				return { content: [text(JSON.stringify(result, null, 2))], details: result };
			}
			const result = await call("status", {}, 20_000);
			return { content: [text(JSON.stringify(result, null, 2))], details: result };
		},
	});

	pi.registerTool({
		name: "rdp_clipboard",
		label: "Desktop Clipboard",
		description:
			"Read the remote clipboard, or set it by passing text (VNC transport only). Setting the clipboard and then " +
			"pressing ctrl+v is far faster and more reliable than typing long text with rdp_keyboard. Reading requires " +
			"the VNC transport too: only it receives clipboard updates from the server.",
		promptSnippet: "Read or set the remote clipboard",
		parameters: Type.Object({
			text: Type.Optional(
				Type.String({ description: "Set the remote clipboard to this text instead of reading it (VNC only)" }),
			),
		}),
		exposure: "deferred",
		namespace: NAMESPACE,
		executionMode: "sequential",
		async execute(_id, params) {
			if (params.text !== undefined && bridge.protocol === "rdp") {
				throw new Error("Setting the clipboard requires the VNC transport (ClientCutText) — it is not available over RDP.");
			}
			const result = await call("clipboard", params.text === undefined ? {} : { text: params.text }, 20_000);
			if (params.text !== undefined) {
				const length = Number(result.length ?? params.text.length);
				return {
					content: [text(`Set the remote clipboard to ${length} characters. Paste it in a remote window with rdp_keyboard key "ctrl+v".`)],
					details: { set: true, length },
				};
			}
			const value = (result.text as string) ?? "";
			return {
				content: [text(value || "The remote clipboard is empty or not available on this transport.")],
				details: { set: false, length: value.length },
			};
		},
	});

	pi.registerCommand("rdp", {
		description:
			"RDP computer use: /rdp connect [host] | status | doctor | shot [path] | region x y w h [path] | disconnect",
		handler: async (rawArgs, ctx) => {
			const [subcommand, ...rest] = rawArgs.trim().split(/\s+/);
			try {
				switch (subcommand) {
					case "connect": {
						const target = resolveTarget({ host: rest[0] });
						const password =
							config.password ?? (config.protocol === "vnc" ? "" : undefined);
						if (password === undefined) {
							throw new Error("No password configured. Set RDP_PASSWORD or the config file.");
						}
						const { protocol, port } = await openSession(target, {
							username: config.username,
							password,
							domain: config.domain,
							width: config.width,
							height: config.height,
						});
						liveConnection = {
							host: target.host,
							port,
							protocol,
							username: config.username,
							password,
							domain: config.domain,
							width: config.width,
							height: config.height,
						};
						sessionConsent = true;
						ctx.ui.notify(`Connected to ${target.host}:${port} over ${protocol.toUpperCase()}.`, "info");
						return;
					}
					case "status": {
						const status = await call("status", {}, 20_000);
						ctx.ui.notify(JSON.stringify(status), status.connected ? "info" : "warning");
						return;
					}
					case "doctor": {
						const doctor = await call("doctor", {}, 30_000);
						ctx.ui.notify(JSON.stringify(doctor, null, 2), "info");
						return;
					}
					case "shot": {
						const result = await call("screenshot", { highlight_cursor: true, timeout: 6 });
						const target = rest[0] ?? join("/tmp", `rdp-shot-${Date.now()}.png`);
						writeFileSync(target, Buffer.from(result.image_base64 as string, "base64"));
						ctx.ui.notify(`Saved ${result.width}x${result.height} screenshot to ${target}`, "info");
						return;
					}
					case "region": {
						const [x, y, width, height] = rest.map((value) => Number(value));
						if ([x, y, width, height].some((value) => !Number.isFinite(value))) {
							throw new Error("Usage: /rdp region x y width height [path]");
						}
						const result = await call("screenshot", {
							region: { x, y, width, height },
							highlight_cursor: true,
							timeout: 6,
						});
						const target = rest[4] ?? join("/tmp", `rdp-region-${Date.now()}.png`);
						writeFileSync(target, Buffer.from(result.image_base64 as string, "base64"));
						ctx.ui.notify(`Saved ${result.width}x${result.height} region to ${target}`, "info");
						return;
					}
					case "disconnect": {
						await call("disconnect", {}, 30_000);
						bridge.stop();
						liveConnection = null;
						lastCapture = null;
						sessionConsent = false;
						ctx.ui.notify("Desktop session closed.", "info");
						return;
					}
					default:
						ctx.ui.notify(
							"Usage: /rdp connect [host] | status | doctor | shot [path] | region x y width height [path] | disconnect",
							"warning",
						);
				}
			} catch (error) {
				ctx.ui.notify(`RDP: ${(error as Error).message}`, "error");
			}
		},
	});
}
