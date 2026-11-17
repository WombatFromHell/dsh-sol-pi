/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { apply } from "../src/sol-dsh/index.ts";
import { attachActionFusion, extendParameters, hasThenRunParameter } from "../src/sol-dsh/action-fusion.ts";
import { DEFAULT_SOL_DSH_CONFIG, resolveSolDshConfig } from "../src/sol-dsh/config.ts";
import { reduceDiagnosticResult, reductionEligibility, resolveReducerRoute } from "../src/sol-dsh/epr.ts";
import {
	acceptContent,
	listenPostExecute,
	textOf,
	type DshAgent,
	type DshContext,
	type ToolDefinition,
} from "../src/sol-dsh/host.ts";
import { zh, en } from "../src/sol-dsh/client/locales.ts";
import { decideCompaction, DEFAULT_COMPACTION_ECONOMICS } from "../src/sol-core/online-context-compact/economics.ts";
import {
	createObservationFromText,
	placeholderFor,
	shouldReplaceObservationAtBirth,
} from "../src/sol-core/observation-pack/observation.ts";
import { packObservation } from "../src/sol-dsh/observation-pack.ts";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("sol-dsh config", () => {
	it("fills the DSH best profile when omitted", () => {
		expect(DEFAULT_SOL_DSH_CONFIG.actionFusion.enabled).toBe(true);
		expect(DEFAULT_SOL_DSH_CONFIG.observationPack).toMatchObject({
			enabled: true,
			mode: "immediate",
			fullSends: 0,
			thresholdBytes: 10_240,
		});
		expect(DEFAULT_SOL_DSH_CONFIG.evidencePreservingReducer.enabled).toBe(true);
		expect(DEFAULT_SOL_DSH_CONFIG.evidencePreservingReducer.reducerProvider).toBe("");
		expect(DEFAULT_SOL_DSH_CONFIG.onlineContextCompact.cacheWriteReadRatio).toBe(50);
		expect(DEFAULT_SOL_DSH_CONFIG.onlineContextCompact.keepRecentTokens).toBe(0);
		// Overlaps dsh-vcc compaction, so it stays off until its host hooks are ported to DSH 0.2.2.
		expect(DEFAULT_SOL_DSH_CONFIG.onlineContextCompact.enabled).toBe(false);
	});

	it("keeps sibling defaults when a nested metric is overridden", () => {
		const config = resolveSolDshConfig({
			onlineContextCompact: { cacheWriteReadRatio: 30 },
		});
		expect(config.onlineContextCompact.cacheWriteReadRatio).toBe(30);
		expect(config.onlineContextCompact.enabled).toBe(false);
		expect(config.actionFusion.enabled).toBe(true);
	});

	it("rejects immediate mode with fullSends", () => {
		expect(() =>
			resolveSolDshConfig({
				observationPack: { mode: "immediate", fullSends: 2 },
			}),
		).toThrow(/fullSends/);
	});

	it("rejects a half-specified reducer route", () => {
		expect(() =>
			resolveSolDshConfig({
				evidencePreservingReducer: { reducerProvider: "deepseek" },
			}),
		).toThrow(/reducerProvider/);
	});

	it("rejects unknown and credential keys", () => {
		expect(() => resolveSolDshConfig({ locale: "zh" })).toThrow(/forbidden|unknown/i);
		expect(() => resolveSolDshConfig({ apiKey: "secret" })).toThrow(/forbidden/);
		expect(() => resolveSolDshConfig({ extra: true })).toThrow(/unknown/);
	});
});

describe("sol-dsh locale dictionaries", () => {
	it("ships identical zh and en keys", () => {
		expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
	});
});

describe("sol-dsh EPR eligibility", () => {
	const config = DEFAULT_SOL_DSH_CONFIG.evidencePreservingReducer;

	it("reduces a diagnostic pytest log", () => {
		const body = `${"error: boom\n".repeat(500)}`;
		expect(reductionEligibility("pytest -q", body, config)).toBe("reduce");
	});

	it("skips secrets and tiny logs", () => {
		expect(reductionEligibility("pytest", "short", config)).toBe("small");
		expect(reductionEligibility("pytest", `api_key=abcd\n${"x".repeat(5000)}`, config)).toBe("secret");
		expect(reductionEligibility("echo hi", `${"line\n".repeat(900)}`, config)).toBe("non-diagnostic");
	});

	it("treats node --check and vitest as diagnostic", () => {
		const body = `${"error: boom\n".repeat(500)}`;
		expect(reductionEligibility("node --check internal/foo.js", body, config)).toBe("reduce");
		expect(reductionEligibility("vitest run", body, config)).toBe("reduce");
	});

	it("resolves the live Agent.options route before session.model.id", () => {
		expect(
			resolveReducerRoute(config, {
				ctx: {} as DshAgent["ctx"],
				options: { provider: "local", model: "grok-4.6" },
				session: { model: { provider: "wrong", id: "stale" } },
			}),
		).toEqual({ provider: "local", model: "grok-4.6" });
		expect(resolveReducerRoute(config, { ctx: {} as DshAgent["ctx"] })).toEqual({});
	});

	it("archives a diagnostic log when Agent.options supplies the route", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sol-dsh-epr-route-"));
		const agent = {
			ctx: {} as DshAgent["ctx"],
			options: { provider: "local", model: "grok-4.6" },
			session: { id: "session-epr", dir },
		} as DshAgent;
		const ctx = {
			llm: {
				async *stream() {},
			},
		};
		const body = `${"error: boom\n".repeat(500)}`;
		await reduceDiagnosticResult(
			ctx as never,
			{
				name: "bash",
				arguments: { command: "go test ./..." },
				callId: "call-epr",
			},
			{ content: [{ type: "text", text: body }] },
			config,
			agent,
		);
		const objects = join(dir, "dsh-sol-pi", "session-epr", "evidence-preserving-reducer", "objects");
		expect(existsSync(objects)).toBe(true);
		expect(readdirSync(objects).length).toBeGreaterThan(0);
	});
});

describe("sol-dsh observation placeholder", () => {
	it("points retrieval at read/grep instead of obs_recall", () => {
		const root = mkdtempSync(join(tmpdir(), "sol-dsh-obs-"));
		const observation = createObservationFromText("bash", "call-1", "a".repeat(20_000), root, 10_240);
		expect(observation).toBeDefined();
		const text = placeholderFor(observation!, {
			fullSends: 0,
			excerptBytes: 1024,
			retrieve: "read or grep the spill locator spill:1",
		});
		expect(text).toContain("read or grep");
		expect(text).not.toContain("obs_recall");
	});
});

describe("sol-dsh immediate observation replace policy", () => {
	it("replaces only command dumps at birth", () => {
		expect(shouldReplaceObservationAtBirth("bash")).toBe(true);
		expect(shouldReplaceObservationAtBirth("edit")).toBe(true);
		expect(shouldReplaceObservationAtBirth("write")).toBe(true);
		expect(shouldReplaceObservationAtBirth("grep")).toBe(false);
		expect(shouldReplaceObservationAtBirth("read")).toBe(false);
		expect(shouldReplaceObservationAtBirth("hindsight_read_knowledge_page")).toBe(false);
		expect(shouldReplaceObservationAtBirth("skill")).toBe(false);
	});

	it("keeps retrieval bash inline and still packs tests/builds", () => {
		expect(shouldReplaceObservationAtBirth("bash", "grep -RniE archive /opt/homebrew/lib")).toBe(false);
		expect(shouldReplaceObservationAtBirth("bash", "find /opt/homebrew/lib -type f | head -500")).toBe(false);
		expect(shouldReplaceObservationAtBirth("bash", "git diff -- internal/desktop/bridge_host.go")).toBe(false);
		expect(shouldReplaceObservationAtBirth("bash", "git show HEAD:pkg/api/foo.go | sed -n '1,220p'")).toBe(false);
		expect(shouldReplaceObservationAtBirth("bash", "go test ./pkg/services/... -count=1")).toBe(true);
		expect(shouldReplaceObservationAtBirth("bash", "make swagger\ngit diff --check")).toBe(true);
		expect(shouldReplaceObservationAtBirth("bash", "ps -axo pid=,command=")).toBe(true);
	});

	it("packs oversized bash and leaves oversized knowledge pages inline", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sol-dsh-obs-policy-"));
		const agent = {
			id: "session-test",
			ctx: {},
			session: { id: "session-test", dir },
		} as unknown as DshAgent;
		const config = DEFAULT_SOL_DSH_CONFIG.observationPack;
		const huge = "a".repeat(20_000);

		const packed = await packObservation(
			{
				name: "bash",
				arguments: { command: "go test ./..." },
				callId: "call-bash",
			},
			{ content: [{ type: "text", text: huge }] },
			config,
			agent,
		);
		expect(packed?.content?.[0]).toMatchObject({ type: "text" });
		expect(String((packed?.content?.[0] as { text: string }).text)).toContain("large tool result stored");

		const retrieval = await packObservation(
			{
				name: "bash",
				arguments: { command: "git diff -- README.md" },
				callId: "call-diff",
			},
			{ content: [{ type: "text", text: huge }] },
			config,
			agent,
		);
		expect(retrieval).toBeUndefined();

		const skipped = await packObservation(
			{
				name: "hindsight_read_knowledge_page",
				arguments: {},
				callId: "call-kp",
			},
			{ content: [{ type: "text", text: huge }] },
			config,
			agent,
		);
		expect(skipped).toBeUndefined();

		const grep = await packObservation(
			{ name: "grep", arguments: {}, callId: "call-grep" },
			{ content: [{ type: "text", text: huge }] },
			config,
			agent,
		);
		expect(grep).toBeUndefined();

		const objects = join(dir, "dsh-sol-pi", "session-test", "observation-pack", "objects");
		expect(readdirSync(objects)).toHaveLength(1);
	});

	it("spills through ctx.spillStore with the DSH 0.2.2 SaveTextSpill shape", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sol-dsh-obs-spill-"));
		const agent = {
			id: "session-spill",
			session: { id: "session-spill" },
		} as DshAgent;
		const saved: Record<string, unknown>[] = [];
		const spill = {
			saveText: async (input: Record<string, unknown>) => {
				saved.push(input);
				return {
					locator: "spill:1",
					bytes: 20_000,
					retrievalHint: "read the artifact",
				};
			},
		};
		const packed = await packObservation(
			{
				name: "bash",
				arguments: { command: "go test ./..." },
				callId: "call-spill",
			},
			{ content: [{ type: "text", text: "a".repeat(20_000) }], isError: false },
			DEFAULT_SOL_DSH_CONFIG.observationPack,
			agent,
			spill,
		);
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			owner: { sessionId: "session-spill" },
			source: {
				kind: "tool",
				toolName: "bash",
				callId: "call-spill",
				label: "result",
			},
			content: "a".repeat(20_000),
		});
		expect(typeof saved[0]?.suggestedName).toBe("string");
		expect(String((packed?.content?.[0] as { text: string }).text)).toContain("spill:1");
	});
});

describe("sol-dsh apply", () => {
	it("registers native listeners without a default export", async () => {
		const events: string[] = [];
		const warnings: string[] = [];
		const ctx: {
			on(event: string, _listener: (...args: never[]) => unknown): () => void;
			inject(deps: readonly string[], callback: (child: never) => void): void;
			tools: {
				get(): undefined;
				register(): () => void;
				execute: () => Promise<{ results: never[] }>;
			};
			llm: { stream: () => AsyncGenerator };
			logger: { warn(message: string): void };
		} = {
			on(event: string, _listener: (...args: never[]) => unknown) {
				events.push(event);
				return () => {};
			},
			inject(deps: readonly string[], callback: (child: never) => void) {
				const child = {
					on(event: string, _listener: (...args: never[]) => unknown) {
						events.push(event);
						return () => {};
					},
					systemPrompt: deps.includes("systemPrompt")
						? {
								section() {
									return () => {};
								},
								getSectionOrder() {
									return 800;
								},
							}
						: undefined,
					agents: deps.includes("agents") ? { list: () => [] } : undefined,
					spillStore: deps.includes("spillStore")
						? {
								saveText: async () => ({
									locator: "spill:1",
									bytes: 0,
									retrievalHint: "",
								}),
							}
						: undefined,
					effect() {},
					tools: {
						get() {
							return undefined;
						},
						register() {
							return () => {};
						},
						execute: async () => ({ results: [] }),
					},
					llm: {
						stream: async function* () {},
					},
				};
				callback(child as never);
			},
			tools: {
				get() {
					return undefined;
				},
				register() {
					return () => {};
				},
				execute: async () => ({ results: [] }),
			},
			llm: {
				stream: async function* () {},
			},
			logger: { warn: (message: string) => warnings.push(message) },
		};
		apply(ctx as never, {});
		expect(events).toContain("tools/post-execute");
		expect(events).toContain("agent/created");
		// `agent/session-start` is not a DSH 0.2.2 event; OCC is not wired, so no pre-step hook.
		expect(events).not.toContain("agent/session-start");
		expect(events).not.toContain("agent/pre-step");
		expect(events).not.toContain("tools/ptc-dispatch-log");
		const mod = await import("../src/sol-dsh/index.ts");
		expect("default" in mod).toBe(false);
		expect(mod.name).toBe("dsh-sol-pi");
		expect(mod.inject).toEqual(["tools", "llm"]);
	});

	it("advertises then_run only for names the assembly scope can actually call", () => {
		let sectionText: ((context: { scope?: unknown }) => string) | undefined;
		const thenRun = { type: "object" };
		const fused = (name: string) => ({
			name,
			description: name,
			parameters: { type: "object", properties: { then_run: thenRun } },
		});
		// Global layer holds the fused pair; the agent's own layer shadows `edit`
		// with a peer plugin's contract that has no `then_run`.
		const tools = {
			get: (name: string, scope?: unknown) =>
				scope === "agent-1" && name === "edit"
					? {
							name: "edit",
							description: "hashline",
							parameters: {
								type: "object",
								properties: { file: { type: "string" } },
							},
						}
					: name === "edit" || name === "write"
						? fused(name)
						: undefined,
			register: () => () => {},
			execute: async () => ({ results: [] }),
		};
		const ctx = {
			on: () => () => {},
			inject: (_deps: readonly string[], callback: (child: never) => void) =>
				callback({
					systemPrompt: {
						section: (section: { text: (context: { scope?: unknown }) => string }) => {
							sectionText = section.text;
							return () => {};
						},
						getSectionOrder: () => 800,
					},
					effect() {},
					tools,
					llm: { stream: async function* () {} },
				} as never),
			tools,
			llm: { stream: async function* () {} },
			logger: { warn: () => {} },
		};
		apply(ctx as never, {});
		expect(sectionText?.({ scope: "agent-1" })).toContain("write accepts");
		expect(sectionText?.({ scope: "agent-1" })).not.toContain("edit");
		expect(sectionText?.({})).toContain("edit and write accept");
	});

	it("says so when onlineContextCompact is enabled but not wired", () => {
		const warnings: string[] = [];
		apply(
			{
				on: () => () => {},
				inject: () => {},
				tools: {
					get: () => undefined,
					register: () => () => {},
					execute: async () => ({ results: [] }),
				},
				llm: { stream: async function* () {} },
				logger: { warn: (message: string) => warnings.push(message) },
			} as never,
			{ onlineContextCompact: { enabled: true } },
		);
		expect(warnings.join(" ")).toMatch(/onlineContextCompact/i);
	});
});

describe("sol-dsh DSH native seams", () => {
	it("extends edit JSON schema with then_run", () => {
		const parameters = extendParameters({
			type: "object",
			properties: {
				file_path: { type: "string" },
				old_string: { type: "string" },
				new_string: { type: "string" },
			},
			required: ["file_path", "old_string", "new_string"],
		});
		expect(hasThenRunParameter(parameters)).toBe(true);
		const properties = parameters.properties as Record<string, { required?: string[] }>;
		expect(properties.then_run?.required).toEqual(["command"]);
	});

	it("shadows edit on the agent-scoped registry", () => {
		const registered: ToolDefinition[] = [];
		const base: ToolDefinition = {
			name: "edit",
			description: "Edit an existing UTF-8 text file by replacing literal text.",
			parameters: {
				type: "object",
				properties: { file_path: { type: "string" } },
			},
			output: { schema: { type: "object" }, render: () => [] },
			async execute() {
				return { path: "x" };
			},
		};
		const agent = {
			id: "agent-1",
			ctx: {
				tools: {
					get(name: string) {
						return name === "edit" ? base : undefined;
					},
					register(definition: ToolDefinition) {
						registered.push(definition);
						return () => {};
					},
					execute: async () => ({ results: [] }),
				},
			},
		} as unknown as DshAgent;
		attachActionFusion(agent.ctx, agent, () => true);
		expect(registered).toHaveLength(1);
		expect(registered[0]?.name).toBe("edit");
		expect(hasThenRunParameter(registered[0]?.parameters ?? {})).toBe(true);
		expect(registered[0]?.description).toMatch(/then_run/);
		// The base contract is kept; only the skip marker the value carries is declared.
		expect(base.output?.schema).toEqual({ type: "object" });
		expect(registered[0]?.output?.render).toBe(base.output?.render);
		expect((registered[0]?.output?.schema as { properties?: Record<string, unknown> }).properties?.then_run).toBeDefined();
	});
	it("registers a delegating variant instead of taking a peer's edit name", () => {
		const registered: ToolDefinition[] = [];
		const warnings: ToolDefinition[] = [];
		const hashline: ToolDefinition = {
			name: "edit",
			description: "Edit a file by hashline anchor ranges.",
			parameters: {
				type: "object",
				properties: { file: { type: "string" }, edits: { type: "array" } },
			},
			output: { schema: { type: "object" }, render: () => [] },
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const agent = {
			id: "agent-1",
			ctx: {
				logger: { warn: (msg: string) => warnings.push(msg as never) },
				tools: {
					get: (name: string) => (name === "edit" ? hashline : undefined),
					register: (definition: ToolDefinition) => {
						registered.push(definition);
						return () => {};
					},
					execute: async () => ({ results: [] }),
				},
			},
		} as unknown as DshAgent;
		attachActionFusion(agent.ctx, agent, () => true);
		expect(registered.map((definition) => definition.name)).toEqual(["edit_and_run"]);
		expect(warnings).toEqual([]);
		const parameters = registered[0]?.parameters as {
			properties: Record<string, unknown>;
		};
		expect(hasThenRunParameter(parameters)).toBe(true);
		expect(parameters.properties.file).toBeDefined();
		expect(parameters.properties.edits).toBeDefined();
	});

	it("survives a tools/change emission raised from inside the sync pass", () => {
		// DSH raises `tools/change` from inside `tools.get`/`register` (lazy layer assembly), so
		// the handler used to re-enter itself and pin a core when a workspace is created (#18).
		const registered: ToolDefinition[] = [];
		const handlers: Array<() => unknown> = [];
		let emissions = 0;
		let lookups = 0;
		let peerAcceptsThenRun = false;
		const emit = (): void => {
			emissions += 1;
			if (emissions > 100) throw new Error("tools/change storm: unbounded re-entry");
			for (const handler of handlers) handler();
		};
		const hashline: ToolDefinition = {
			name: "edit",
			description: "Edit a file by hashline anchor ranges.",
			parameters: peerAcceptsThenRun
				? { type: "object", properties: { file: { type: "string" }, then_run: { type: "object" } } }
				: { type: "object", properties: { file: { type: "string" }, edits: { type: "array" } } },
			output: { schema: { type: "object" }, render: () => [] },
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const agent = {
			id: "agent-1",
			ctx: {
				tools: {
					get: (name: string) => {
						emit();
						lookups += 1;
						return name === "edit"
							? {
									...hashline,
									parameters: peerAcceptsThenRun
										? { type: "object", properties: { file: { type: "string" }, then_run: { type: "object" } } }
										: { type: "object", properties: { file: { type: "string" }, edits: { type: "array" } } },
								}
								: undefined;
					},
					register: (definition: ToolDefinition) => {
						registered.push(definition);
						emit();
						return (): void => {
							emit();
						};
					},
					execute: async () => ({ results: [] }),
				},
				on: (event: string, handler: (...args: never[]) => unknown) => {
					if (event === "tools/change") handlers.push(handler);
				},
			},
			agents: { list: () => [] },
		} as unknown as DshAgent;
		attachActionFusion(agent.ctx, agent, () => true);
		expect(registered.map((definition) => definition.name)).toEqual(["edit_and_run"]);
		// A genuine change outside our own pass still re-decides the claim.
		const lookupsAfterAttach = lookups;
		peerAcceptsThenRun = true;
		emit();
		expect(lookups).toBeGreaterThan(lookupsAfterAttach);
	});

	it("fuses the same name when the visible contract is sol-pi's literal one", () => {
		const registered: ToolDefinition[] = [];
		const base = (name: string): ToolDefinition => ({
			name,
			description: `built-in ${name}`,
			parameters: {
				type: "object",
				properties: { file_path: { type: "string" } },
			},
			output: { schema: { type: "object" }, render: () => [] },
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		const agent = {
			id: "agent-1",
			ctx: {
				tools: {
					get: base,
					register: (definition: ToolDefinition) => {
						registered.push(definition);
						return () => {};
					},
					execute: async () => ({ results: [] }),
				},
			},
		} as unknown as DshAgent;
		attachActionFusion(agent.ctx, agent, () => true);
		expect(registered.map((definition) => definition.name)).toEqual(["edit", "write"]);
	});

	it("registers nothing when the visible definition already accepts then_run", () => {
		const registered: ToolDefinition[] = [];
		const peer = (name: string): ToolDefinition => ({
			name,
			description: `peer ${name}`,
			parameters: {
				type: "object",
				properties: { file: { type: "string" }, then_run: { type: "object" } },
			},
			output: { schema: { type: "object" }, render: () => [] },
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		const agent = {
			id: "agent-1",
			ctx: {
				tools: {
					get: peer,
					register: (definition: ToolDefinition) => {
						registered.push(definition);
						return () => {};
					},
					execute: async () => ({ results: [] }),
				},
			},
		} as unknown as DshAgent;
		attachActionFusion(agent.ctx, agent, () => true);
		expect(registered).toHaveLength(0);
	});

	/** Peer-owned hashline `edit` plus a fake batch executor, so the variant reaches the pipeline. */
	function delegatingEditFixture() {
		const dir = mkdtempSync(join(tmpdir(), "sol-dsh-delegating-"));
		const filePath = join(dir, "a.txt");
		writeFileSync(filePath, "x\n");
		const batches: Record<string, unknown>[] = [];
		const delegateArgs: unknown[] = [];
		const fused: ToolDefinition[] = [];
		const base: ToolDefinition = {
			name: "edit",
			description: "Edit a file by hashline anchor ranges.",
			parameters: {
				type: "object",
				properties: { file: { type: "string" }, edits: { type: "array" } },
			},
			output: { schema: { type: "object" }, render: () => [] },
			async execute(args: unknown) {
				delegateArgs.push(args);
				return {
					content: [
						{
							type: "text",
							text: `edited ${String((args as { file: string }).file)}`,
						},
					],
				};
			},
		};
		const ctx = {
			logger: { warn() {} },
			tools: {
				get: (name: string) => (name === "edit" ? base : undefined),
				register: (definition: ToolDefinition) => {
					fused.push(definition);
					return () => {};
				},
				execute: async (input: Record<string, unknown>) => {
					batches.push(input);
					const call = (input.calls as { id: string }[])[0]!;
					return {
						results: [
							{
								callId: call.id,
								result: {
									content: [{ type: "text", text: "npm test passed" }],
									isError: false,
								},
							},
						],
					};
				},
			},
		};
		const agent = {
			id: "agent-1",
			ctx,
			session: { id: "session-1", header: { cwd: dir } },
		} as unknown as DshAgent;
		attachActionFusion(ctx as never, agent, () => true);
		const exec = {
			name: "edit_and_run",
			arguments: {
				file: filePath,
				edits: [{ anchor_from: "a", anchor_to: "b", replace_with: "c" }],
				then_run: { command: "npm test" },
			},
			callId: "call-1",
			rootCallId: "call-1",
			token: Symbol("t"),
			signal: new AbortController().signal,
			agent,
		};
		return { batches, delegateArgs, filePath, tool: fused[0]!, exec };
	}

	it("delegates the peer payload untouched and runs then_run in one observation", async () => {
		const { batches, delegateArgs, filePath, tool, exec } = delegatingEditFixture();
		expect(tool?.name).toBe("edit_and_run");
		const value = await tool.execute(exec.arguments, exec);
		expect(delegateArgs).toEqual([
			{
				file: filePath,
				edits: [{ anchor_from: "a", anchor_to: "b", replace_with: "c" }],
			},
		]);
		expect(value).toEqual({
			content: [{ type: "text", text: `edited ${filePath}` }],
		});
		expect(batches).toHaveLength(1);
		expect(batches[0]).toMatchObject({
			calls: [
				{
					type: "tool-call",
					id: "call-1-then-run",
					name: "bash",
				},
			],
		});
		expect(textOf(tool.finalizeContent!(exec as never, value as never))).toContain("[then_run:succeeded]");
	});

	it("fuses on the agent's own layer and never falls back to the global one", () => {
		const onAgent: ToolDefinition[] = [];
		const onGlobal: ToolDefinition[] = [];
		const warnings: string[] = [];
		const base = (name: string): ToolDefinition => ({
			name,
			description: `built-in ${name}`,
			parameters: {
				type: "object",
				properties: { file_path: { type: "string" } },
			},
			output: { schema: { type: "object" }, render: () => [] },
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		const ctx = {
			logger: { warn: (msg: string) => warnings.push(msg) },
			tools: {
				get: (name: string) => base(name),
				register: (definition: ToolDefinition) => {
					onGlobal.push(definition);
					return () => {};
				},
				execute: async () => ({ results: [] }),
			},
		};
		const agent = {
			id: "agent-1",
			ctx: {
				tools: {
					get: (name: string) => base(name),
					// dsh-better-edit already claimed `edit` on this layer during its listener.
					register: (definition: ToolDefinition) => {
						if (definition.name === "edit") throw new Error('tool "edit" is already registered in this scope');
						onAgent.push(definition);
						return () => {};
					},
					execute: async () => ({ results: [] }),
				},
			},
		} as unknown as DshAgent;
		attachActionFusion(ctx as never, agent, () => true);
		expect(onGlobal).toHaveLength(0);
		expect(onAgent.map((definition) => definition.name)).toEqual(["write"]);
		expect(warnings.join(" ")).toContain("could not register edit");
	});

	it("keeps a peer's contested name and claims the variant once its contract is visible", () => {
		const onAgent: ToolDefinition[] = [];
		const disposed: string[] = [];
		const warnings: string[] = [];
		const listeners: ((...args: never[]) => unknown)[] = [];
		let visibleEdit: ToolDefinition | undefined;
		const base = (name: string): ToolDefinition => ({
			name,
			description: `built-in ${name}`,
			parameters: { type: "object", properties: { file_path: { type: "string" } } },
			output: { schema: { type: "object" }, render: () => [] },
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		const tools = {
			get: (name: string) => (name === "edit" && visibleEdit ? visibleEdit : base(name)),
			// dsh-better-edit claimed `edit` on this layer during its own listener.
			register: (definition: ToolDefinition) => {
				if (definition.name === "edit") throw new Error('tool "edit" is already registered in this scope');
				onAgent.push(definition);
				return () => {
					disposed.push(definition.name);
				};
			},
			execute: async () => ({ results: [] }),
		};
		const agent = {
			id: "agent-1",
			ctx: {
				tools,
				on: (_event: string, listener: (...args: never[]) => unknown) => {
					listeners.push(listener);
					return () => {};
				},
			},
		} as unknown as DshAgent;
		const ctx = { logger: { warn: (msg: string) => warnings.push(msg) }, tools } as unknown as DshContext;

		attachActionFusion(ctx, agent, () => true);
		expect(onAgent.map((definition) => definition.name)).toEqual(["write"]);
		expect(warnings.join(" ")).toContain("could not register edit");

		// The peer's hashline contract becomes visible; the claim moves to the variant.
		visibleEdit = {
			name: "edit",
			description: "Edit a range of lines by HASH anchors.",
			parameters: { type: "object", properties: { file: { type: "string" }, edits: { type: "array" } } },
			output: { schema: { type: "object" }, render: () => [] },
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		for (const listener of listeners) listener();
		expect(onAgent.map((definition) => definition.name)).toEqual(["write", "edit_and_run"]);
		// A failed same-name claim must never unhook the peer's entry.
		expect(disposed).toEqual([]);
	});

	/** Real `write` file on disk plus a fake batch executor, so then_run reaches the pipeline. */
	function fusedWriteFixture(bashText = "npm test passed", bashIsError = false) {
		const dir = mkdtempSync(join(tmpdir(), "sol-dsh-fusion-"));
		const filePath = join(dir, "a.txt");
		writeFileSync(filePath, "x\n");
		const batches: Record<string, unknown>[] = [];
		const fused: ToolDefinition[] = [];
		const base: ToolDefinition = {
			name: "write",
			description: "Create or fully replace a UTF-8 text file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
			},
			output: { schema: { type: "object" }, render: () => [] },
			async execute(args: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `wrote ${String((args as { path: string }).path)}`,
						},
					],
				};
			},
		};
		const ctx = {
			logger: { warn() {} },
			tools: {
				get: (name: string) => (name === "write" ? base : undefined),
				register: (definition: ToolDefinition) => {
					fused.push(definition);
					return () => {};
				},
				execute: async (input: Record<string, unknown>) => {
					batches.push(input);
					const call = (input.calls as { id: string }[])[0]!;
					return {
						results: [
							{
								callId: call.id,
								result: {
									content: [{ type: "text", text: bashText }],
									isError: bashIsError,
								},
							},
						],
					};
				},
			},
		};
		const agent = {
			id: "agent-1",
			ctx,
			session: { id: "session-1", header: { cwd: dir } },
		} as unknown as DshAgent;
		attachActionFusion(ctx as never, agent, () => true);
		const exec = (overrides: Record<string, unknown> = {}) => ({
			name: "write",
			arguments: {
				path: filePath,
				content: "x\n",
				then_run: { command: "npm test" },
			},
			callId: "call-1",
			rootCallId: "call-1",
			token: Symbol("t"),
			signal: new AbortController().signal,
			agent,
			...overrides,
		});
		return { filePath, batches, tool: fused[0]!, exec };
	}

	it("dispatches then_run through the DSH 0.2.2 tool batch", async () => {
		const { filePath, batches, tool, exec } = fusedWriteFixture();
		const call = exec();
		const value = await tool.execute(call.arguments, call);
		expect(value).toEqual({
			content: [{ type: "text", text: `wrote ${filePath}` }],
		});
		expect(batches).toHaveLength(1);
		expect(batches[0]).toMatchObject({
			calls: [
				{
					type: "tool-call",
					id: "call-1-then-run",
					name: "bash",
				},
			],
		});
		expect(batches[0]?.signal).toBe(call.signal);
		expect(batches[0]?.agent).toBe(call.agent);
		const content = tool.finalizeContent!(call as never, value as never);
		expect(textOf(content)).toContain("[then_run:succeeded]");
		expect(textOf(content)).toContain("npm test passed");
	});

	it("maps then_run timeout seconds onto the DSH bash timeoutMs", async () => {
		const { filePath, batches, tool, exec } = fusedWriteFixture();
		const call = exec({
			arguments: { path: filePath, content: "x\n", then_run: { command: "npm test", timeout: 12 } },
		});
		await tool.execute(call.arguments, call);
		const dispatched = batches[0]?.calls as Array<{ arguments?: unknown }> | undefined;
		const args = JSON.parse(String(dispatched?.[0]?.arguments)) as Record<string, unknown>;
		expect(args.timeoutMs).toBe(12_000);
		expect(args.timeout).toBeUndefined();
		expect(args.description).toContain("then_run: npm test");
	});

	it("reports a non-zero bash exit as a failed then_run", async () => {
		// DSH's `bash` sets isError only for validation/transport errors; a non-zero exit is text.
		const { tool, exec } = fusedWriteFixture("0\n[exit code: 7]", false);
		const call = exec();
		const value = await tool.execute(call.arguments, call);
		expect(textOf(tool.finalizeContent!(call as never, value as never))).toContain("[then_run:failed]");
	});

	it("reports a timed-out then_run as failed, not succeeded", async () => {
		// DSH moves an expired command to a background job; its outcome is unknown at this point.
		const { tool, exec } = fusedWriteFixture("[still running after 1000ms; moved to background job bash-abc]", false);
		const call = exec();
		const value = await tool.execute(call.arguments, call);
		const text = textOf(tool.finalizeContent!(call as never, value as never));
		expect(text).toContain("[then_run:failed]");
		expect(text).toContain("bash-abc");
	});

	it("skips then_run inside a transport sub-dispatch", async () => {
		const { batches, tool, exec } = fusedWriteFixture();
		const nested = exec({ callId: "call-2", parent: Symbol("ptc") });
		const value = await tool.execute(nested.arguments, nested);
		expect(batches).toHaveLength(0);
		expect(textOf(tool.finalizeContent!(nested as never, value as never))).toContain("[then_run:skipped]");
		// Codemode hands the program `value`, never content blocks — the skip must be readable there.
		expect((value as { then_run?: string }).then_run).toContain("[then_run:skipped]");
	});

	it("reports a skipped then_run on a string-output mutation under codemode", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sol-dsh-fusion-string-"));
		const filePath = join(dir, "b.txt");
		writeFileSync(filePath, "x\n");
		const base: ToolDefinition = {
			name: "edit",
			description: "Edit a file.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			output: { schema: { type: "string" }, render: () => [] },
			async execute(): Promise<string> {
				return "diff applied";
			},
		};
		const fused: ToolDefinition[] = [];
		const ctx = {
			logger: { warn() {} },
			tools: {
				get: (name: string) => (name === "edit" ? base : undefined),
				register: (definition: ToolDefinition) => {
					fused.push(definition);
					return () => {};
				},
			},
		};
		const agent = { id: "agent-2", ctx, session: { id: "session-2", header: { cwd: dir } } } as unknown as DshAgent;
		attachActionFusion(ctx as never, agent, () => true);
		const tool = fused[0]!;
		const call = {
			name: "edit",
			arguments: { path: filePath, then_run: { command: "npm test" } },
			callId: "call-9",
			rootCallId: "call-9",
			token: Symbol("t"),
			signal: new AbortController().signal,
			agent,
			parent: Symbol("ptc"),
		};
		const value = await tool.execute(call.arguments, call);
		expect(String(value)).toContain("[then_run:skipped]");
	});

	it("declares the skip marker so codemode output validation accepts it", async () => {
		// PTC validates the returned value against the tool's declared output schema. write's
		// schema forbids extra properties, so an undeclared marker fails the whole call even
		// though the mutation already applied.
		const dir = mkdtempSync(join(tmpdir(), "sol-dsh-fusion-schema-"));
		const filePath = join(dir, "c.txt");
		writeFileSync(filePath, "x\\n");
		const declared = { path: { type: "string" }, operation: { type: "string" } };
		const base: ToolDefinition = {
			name: "write",
			description: "Create a file.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			output: { schema: { type: "object", properties: declared, additionalProperties: false }, render: () => [] },
			async execute(): Promise<Record<string, string>> {
				return { path: filePath, operation: "create" };
			},
		};
		const fused: ToolDefinition[] = [];
		const ctx = {
			logger: { warn() {} },
			tools: {
				get: (name: string) => (name === "write" ? base : undefined),
				register: (definition: ToolDefinition) => {
					fused.push(definition);
					return () => {};
				},
			},
		};
		const agent = { id: "agent-3", ctx, session: { id: "session-3", header: { cwd: dir } } } as unknown as DshAgent;
		attachActionFusion(ctx as never, agent, () => true);
		const tool = fused[0]!;
		const call = {
			name: "write",
			arguments: { path: filePath, then_run: { command: "npm test" } },
			callId: "call-11",
			rootCallId: "call-11",
			token: Symbol("t"),
			signal: new AbortController().signal,
			agent,
			parent: Symbol("ptc"),
		};
		const value = (await tool.execute(call.arguments, call)) as Record<string, string>;
		expect(value.then_run).toContain("[then_run:skipped]");
		const schema = tool.output!.schema as { properties?: Record<string, unknown>; additionalProperties?: unknown };
		expect(schema.properties?.then_run).toBeDefined();
		expect(schema.additionalProperties).toBe(false);
		// Every key the value carries must be one the schema declares.
		expect(Object.keys(value)).toEqual(Object.keys(schema.properties!));
	});

	it("dispatches bash with the arguments the DSH tool schema requires", async () => {
		// `bash` requires `description` alongside `command`; omitting it fails argument validation.
		const { batches, tool, exec } = fusedWriteFixture();
		const call = exec();
		await tool.execute(call.arguments, call);
		const sent = JSON.parse(String((batches[0]!.calls as { arguments: string }[])[0]!.arguments)) as Record<
			string,
			unknown
		>;
		expect(sent.command).toBe("npm test");
		expect(typeof sent.description).toBe("string");
		expect(String(sent.description).length).toBeGreaterThan(0);
	});

	it("re-decides the claim after a peer takes the mutation name, without disposing the peer's slot", () => {
		const registered: ToolDefinition[] = [];
		const disposed: string[] = [];
		let visible: ToolDefinition = {
			name: "edit",
			description: "Edit a file by exact string match.",
			parameters: { type: "object", properties: { path: { type: "string" }, old_str: { type: "string" } } },
			async execute(): Promise<{ content: [] }> {
				return { content: [] };
			},
		};
		const listeners: ((...args: never[]) => unknown)[] = [];
		const ctx = {
			logger: { warn: () => {} },
			tools: {
				get: (name: string) => (name === "edit" ? visible : undefined),
				register: (definition: ToolDefinition) => {
					registered.push(definition);
					return () => {
						disposed.push(definition.name);
					};
				},
				execute: async () => ({ results: [] }),
			},
			on: (_event: string, listener: (...args: never[]) => unknown) => {
				listeners.push(listener);
				return () => {};
			},
		} as unknown as DshContext;
		const agent = {
			id: "agent-1",
			ctx,
			session: { id: "session-1", header: { cwd: process.cwd() } },
		} as unknown as DshAgent;

		attachActionFusion(ctx, agent, () => true);
		expect(registered.map((definition) => definition.name)).toEqual(["edit"]);

		// A peer registers its hashline `edit` after our pass; the visible contract now decides.
		visible = {
			name: "edit",
			description: "Edit a range of lines by HASH anchors.",
			parameters: { type: "object", properties: { file: { type: "string" }, edits: { type: "array" } } },
			async execute(): Promise<{ content: [] }> {
				return { content: [] };
			},
		};
		for (const listener of listeners) listener();

		expect(registered.map((definition) => definition.name)).toEqual(["edit", "edit_and_run"]);
		expect(disposed).toEqual([]);
	});

	it("post-execute listeners return { kind: accept, content }", async () => {
		let captured: ((...args: never[]) => unknown) | undefined;
		const ctx = {
			on(_event: string, listener: (...args: never[]) => unknown) {
				captured = listener;
				return () => {};
			},
			inject() {},
			tools: {
				get() {},
				register() {},
				execute: async () => ({ content: [] }),
			},
			llm: { stream: async function* () {} },
		};
		listenPostExecute(ctx as never, async (_exec, _result, decision) =>
			acceptContent(decision, [{ type: "text", text: "packed" }]),
		);
		const decision = await (
			captured as (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>
		)({ name: "bash", args: {} }, { content: [{ type: "text", text: "raw" }] }, async () => ({ kind: "accept" }));
		expect(decision).toEqual({
			kind: "accept",
			content: [{ type: "text", text: "packed" }],
		});
	});
});

describe("sol-dsh OCC ratio 50", () => {
	it("defers when remaining horizon cannot repay a 50× cache miss", () => {
		const decision = decideCompaction({
			writeTokens: 80_000,
			archiveTokens: 40_000,
			memoTokens: 1000,
			contextTokens: 80_000,
			completedBoundaryRequestCounts: [2, 2, 2],
			remainingBoundaries: 1,
			averageContextTokenIncrement: 1000,
			contextWindowTokens: 200_000,
			priorCompactionCount: 1,
			carriedDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
			cacheWriteReadRatio: 50,
			economics: DEFAULT_COMPACTION_ECONOMICS,
		});
		expect(decision.compact).toBe(false);
		expect(decision.incrementalCacheCostRatio).toBe(49);
	});
});
