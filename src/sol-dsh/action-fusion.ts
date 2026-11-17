/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { resolveToolPath, withFusedFileQueue } from "../sol-core/action-fusion/file-queue.ts";
import {
	assertUnchangedBeforeCommand,
	formatThenRunFailure,
	formatThenRunSuccess,
	THEN_RUN_SKIPPED,
	thenRunSkippedError,
	type ThenRunInput,
} from "../sol-core/action-fusion/then-run.ts";
import type { ContentBlock, DshAgent, DshContext, ToolDefinition, ToolExecution, ToolExecutionResult } from "./host.ts";
import { agentFromPayload, recordValue, textOf } from "./host.ts";
import { sessionCwd } from "./runtime-root.ts";

const THEN_RUN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	description:
		"Command to run next on this file after the mutation succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the mutation fails; a non-zero exit is reported but keeps the mutation.",
	properties: {
		command: { type: "string", description: "Bash command to run" },
		timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
	},
	required: ["command"],
} as const;

export const FUSED_TOOLS = ["edit", "write"] as const;

/** Argument keys that carry the target file, across literal and hashline contracts. */
const MUTATION_PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

/** Contracts sol-pi can pass through untouched: the literal path/content shape, not hashline anchors. */
const LITERAL_CONTRACT_KEYS = ["path", "file_path", "filePath"] as const;

const THEN_RUN_LEAD =
	"After a successful mutation, you MUST pass then_run {command, timeout?} to run the immediate format/test/build in the SAME observation. Do not split that follow-up into a later bash turn.";

export function thenRunFromArgs(args: unknown): ThenRunInput | undefined {
	const thenRun = recordValue(args, "then_run");
	const command = recordValue(thenRun, "command");
	if (typeof command !== "string" || command.length === 0) return undefined;
	const timeout = recordValue(thenRun, "timeout");
	return {
		command,
		timeout: typeof timeout === "number" ? timeout : undefined,
	};
}

function mutationPath(args: unknown): string | undefined {
	for (const key of MUTATION_PATH_KEYS) {
		const value = recordValue(args, key);
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function withoutThenRun(args: unknown): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const { then_run: _ignored, ...rest } = args as Record<string, unknown>;
	return rest;
}

/** Codemode hands the program `value`, never content blocks, so a skipped check must be in the value. */
// ponytail: the marker rides in the returned value; a fused tool whose output schema forbids extra
// properties would fail validation there — widen that schema if one ever appears.
function withSkipMarker(value: unknown, marker: string): unknown {
	if (typeof value === "string") return `${value}\n\n${marker}`;
	if (value && typeof value === "object" && !Array.isArray(value)) return { ...value, then_run: marker };
	return value;
}

/** The parameter names a definition declares, in both schema-root and bare-object shapes. */
function declaredProperties(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!parameters) return {};
	return parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
		? (parameters.properties as Record<string, unknown>)
		: parameters;
}

export function extendParameters(parameters: Record<string, unknown>): Record<string, unknown> {
	if ("type" in parameters || "properties" in parameters) {
		return {
			...parameters,
			type: "object",
			properties: {
				...declaredProperties(parameters),
				then_run: THEN_RUN_SCHEMA,
			},
		};
	}
	return { ...parameters, then_run: THEN_RUN_SCHEMA };
}

export function hasThenRunParameter(parameters: Record<string, unknown> | undefined): boolean {
	return Boolean(declaredProperties(parameters).then_run);
}

/** sol-pi passes a payload through untouched only for the literal path/content contract. */
export function isLiteralMutation(base: ToolDefinition): boolean {
	const properties = declaredProperties(base.parameters);
	return LITERAL_CONTRACT_KEYS.some((key) => properties[key] !== undefined);
}

/** Name sol-pi owns when a peer holds the mutation name under a contract it cannot rewrite. */
export function delegatingName(name: string): string {
	return `${name}_and_run`;
}

async function runBash(ctx: DshContext, thenRun: ThenRunInput, exec: ToolExecution): Promise<ToolExecutionResult> {
	const args: Record<string, unknown> = { command: thenRun.command };
	// DSH's `bash` requires `description` next to `command`; omitting it fails argument validation.
	args.description = `then_run: ${thenRun.command.slice(0, 60)}`;
	// DSH's `bash` takes `timeoutMs`; a bare `timeout` passes validation but is ignored.
	if (thenRun.timeout !== undefined) args.timeoutMs = Math.round(thenRun.timeout * 1000);
	const batch = await ctx.tools.execute({
		calls: [
			{
				type: "tool-call",
				id: `${exec.callId}-then-run`,
				name: "bash",
				arguments: JSON.stringify(args),
			},
		],
		signal: exec.signal ?? new AbortController().signal,
		agent: exec.agent,
		toolSet: exec.toolSet,
	});
	return (
		batch.results[0]?.result ?? {
			content: [{ type: "text", text: "bash returned no result." }],
			isError: true,
		}
	);
}

/** DSH's `bash` reports a non-zero exit or an expired command in text, never through `isError`. */
function commandIncomplete(output: string): boolean {
	// ponytail: text markers only; upgrade if DSH exposes exitCode/background state on tool results.
	if (output.includes("moved to background job")) return true; // expired: outcome unknown, job id is in the text
	return [...output.matchAll(/\[exit code: (-?\d+)\]/g)].some((match) => Number(match[1]) !== 0);
}

/**
 * Codemode hands the program the value and validates it against this schema, so a skip marker
 * carried in the value must be a declared property: an undeclared one fails the whole call even
 * though the mutation already applied. Object schemas declare it; string schemas carry it in the
 * text. ponytail: array outputs never see the marker — declare a wrapper if a mutation ever returns one.
 */
function outputWithSkipProperty(output: ToolDefinition["output"]): ToolDefinition["output"] {
	if (!output || !output.schema || typeof output.schema !== "object" || Array.isArray(output.schema)) return output;
	const schema = output.schema as Record<string, unknown>;
	if (schema.type !== "object") return output;
	const properties = (recordValue(schema, "properties") ?? {}) as Record<string, unknown>;
	return { ...output, schema: { ...schema, properties: { ...properties, then_run: { type: "string" } } } };
}

function wrapTool(ctx: DshContext, agent: DshAgent, name: string, base: ToolDefinition): ToolDefinition {
	// A variant under our own name delegates to whatever currently holds the mutation name.
	const target = name === base.name ? () => base : () => resolveBase(ctx, agent, base.name) ?? base;
	const extras = new Map<string | symbol, string>();
	const extraKey = (exec: ToolExecution) => exec.token ?? exec.callId;
	const lead =
		name === base.name ? THEN_RUN_LEAD : `${THEN_RUN_LEAD}\n\n${name} takes the same arguments as ${base.name}.`;
	const description = base.description.includes("then_run") ? base.description : `${lead}\n\n${base.description}`;
	return {
		...base,
		name,
		description,
		parameters: extendParameters(base.parameters ?? {}),
		output: outputWithSkipProperty(base.output),
		isConcurrencySafe: () => false,
		async execute(args: unknown, exec: ToolExecution) {
			const thenRun = thenRunFromArgs(args);
			const rest = withoutThenRun(args);
			const relativePath = mutationPath(args);
			const absolutePath = relativePath ? resolveToolPath(sessionCwd(exec.agent ?? agent), relativePath) : undefined;
			const work = async () => {
				try {
					return await target().execute(rest, exec);
				} catch (error) {
					if (thenRun) throw thenRunSkippedError(error);
					throw error;
				}
			};
			const value = absolutePath ? await withFusedFileQueue(absolutePath, work) : await work();
			if (!thenRun) return value;
			// A skip is only visible to the caller if it rides in the value, under a transport call.
			const skip = (marker: string): unknown => {
				extras.set(extraKey(exec), marker);
				return exec.parent !== undefined ? withSkipMarker(value, marker) : value;
			};
			// Under PTC only calls with a parent may run native tools, so a nested `bash`
			// dispatch from here would be denied as UNKNOWN_TOOL. Skip it; the outer
			// transport call still runs the command the model asked for.
			if (exec.parent !== undefined) {
				return skip(`${THEN_RUN_SKIPPED} transport sub-dispatch; the command was not run.`);
			}
			if (!absolutePath) {
				return skip(`${THEN_RUN_SKIPPED} mutation path is unavailable; the command was not run.`);
			}
			try {
				await assertUnchangedBeforeCommand(absolutePath);
				const bashResult = await runBash(ctx, thenRun, exec);
				const output = textOf(bashResult.content);
				extras.set(
					extraKey(exec),
					bashResult.isError || commandIncomplete(output)
						? formatThenRunFailure(output, new Error(output || "bash failed"))
						: formatThenRunSuccess(output),
				);
			} catch (error) {
				extras.set(extraKey(exec), formatThenRunFailure("", error));
			}
			return value;
		},
		finalizeContent(exec: ToolExecution, result: ToolExecutionResult) {
			const extra = extras.get(extraKey(exec));
			const baseContent = base.finalizeContent?.(exec, result) ?? (result.content as ContentBlock[] | undefined);
			if (!extra) return baseContent;
			const blocks = baseContent ? [...baseContent] : [];
			blocks.push({ type: "text", text: extra });
			return blocks;
		},
	};
}

/** The base is the definition this agent currently sees for the name. */
function resolveBase(ctx: DshContext, agent: DshAgent, name: string): ToolDefinition | undefined {
	return agent.ctx.tools.get(name, agent) ?? ctx.tools.get(name);
}

/**
 * Fusion registers on the AGENT's own layer: dsh-tools refuses a global
 * re-registration of a name a preset already provides, and a layer holds one slot
 * per name. So sol-pi never contests a peer's `edit`/`write`: under a contract it
 * cannot pass through (hashline anchors) it registers `edit_and_run` / `write_and_run`
 * under its own name and delegates to the visible definition. Bundle order therefore
 * decides nothing, and our teardown deletes only our own names. The guidance section
 * reads visible definitions per assembly scope, so a name without `then_run` is never
 * advertised.
 */
export function attachActionFusion(ctx: DshContext, agent: DshAgent, enabled: () => boolean): void {
	if (!enabled()) return;
	const tools = agent.ctx?.tools;
	if (!tools?.register) return;
	// One claim per mutation tool, remembered by the definition WE registered, so a peer that
	// reclaimed the name keeps its own slot and is never disposed by us.
	const claims = new Map<string, { definition: ToolDefinition; dispose: () => void }>();
	const drop = (name: string): void => {
		const claim = claims.get(name);
		if (!claim) return;
		claims.delete(name);
		if (resolveBase(ctx, agent, name) === claim.definition) claim.dispose();
	};
	const syncInner = (): void => {
		if (!enabled()) {
			for (const name of [...claims.keys()]) drop(name);
			return;
		}
		for (const name of FUSED_TOOLS) {
			const base = resolveBase(ctx, agent, name);
			if (!base || hasThenRunParameter(base.parameters)) {
				drop(name);
				continue;
			}
			const claim = isLiteralMutation(base) ? name : delegatingName(name);
			if (claims.get(name)?.definition.name === claim) continue;
			drop(name);
			const definition = wrapTool(ctx, agent, claim, base);
			try {
				claims.set(name, { definition, dispose: tools.register(definition) });
			} catch (error) {
				ctx.logger?.warn?.(
					`dsh-sol-pi: could not register ${claim} with then_run on agent ${agent.id ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	};
	// DSH raises `tools/change` from inside `tools.get`/`register` while it assembles a layer
	// lazily, so calling `sync` from that emission re-entered itself and pinned a core when a
	// workspace was created (#18). Re-entrant emissions of our own pass are ignored; a genuine
	// change arriving outside the pass still re-decides the claim.
	// ponytail: a foreign change arriving mid-pass is dropped — upgrade to a coalesced
	// microtask pass only if DSH stops raising `tools/change` from inside `get`.
	let inPass = false;
	const sync = (): void => {
		if (inPass) return;
		inPass = true;
		try {
			syncInner();
		} finally {
			inPass = false;
		}
	};
	sync();
	agent.ctx.on?.("tools/change", sync as (...args: never[]) => unknown);
}

export function registerActionFusion(ctx: DshContext, enabled: () => boolean = () => true): void {
	// The inject pass and `agent/created` can both reach the same agent; claim once.
	const attached = new WeakSet<object>();
	const attachOnce = (agent: DshAgent): void => {
		if (attached.has(agent)) return;
		attached.add(agent);
		attachActionFusion(ctx, agent, enabled);
	};
	const onAgent = (payload: unknown) => {
		const agent = agentFromPayload(payload);
		if (agent) attachOnce(agent);
	};

	ctx.on("agent/created", onAgent as (...args: never[]) => unknown);

	if (typeof ctx.inject === "function") {
		ctx.inject(["agents"], (child) => {
			try {
				for (const agent of child.agents?.list?.() ?? []) attachOnce(agent);
			} catch (error) {
				ctx.logger?.warn?.(
					`dsh-sol-pi: could not wrap live agents: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	}
}
