/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Structural DSH host surface used by sol-dsh. Typed against the public Cordis
 * plugin contract without importing DSH packages into the Pi typecheck graph.
 */
export type TextBlock = { readonly type: "text"; readonly text: string };

export type ContentBlock = TextBlock | { readonly type: string; readonly [key: string]: unknown };

/** DSH 0.2.2 `ToolExecution` — the shape `tools/post-execute` and tool bodies receive. */
export type ToolExecution = {
	readonly name: string;
	readonly arguments: unknown;
	readonly callId: string;
	readonly rootCallId?: string;
	readonly token?: symbol;
	/** Set only on transport sub-dispatches (PTC `run_code` inner calls). */
	readonly parent?: symbol;
	readonly agent?: DshAgent;
	readonly toolSet?: unknown;
	readonly signal?: AbortSignal;
};

export type ToolExecutionResult = {
	readonly content?: readonly ContentBlock[];
	readonly isError?: boolean;
	readonly value?: unknown;
	readonly [key: string]: unknown;
};

/** DSH `tools/post-execute` waterfall decision — not a raw tool result. */
export type PostToolDecision =
	| {
			kind: "accept";
			content?: ContentBlock[];
			value?: never;
			additionalContexts?: unknown[];
	  }
	| {
			kind: "accept";
			value: unknown;
			content?: never;
			additionalContexts?: unknown[];
	  }
	| {
			kind: "block";
			feedback: ContentBlock[];
			additionalContexts?: unknown[];
	  };

export type ToolDefinition = {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly output?: {
		readonly schema?: unknown;
		render?: (args: unknown, value: unknown) => ContentBlock[];
		presentationMeta?: (args: unknown, value: unknown) => unknown;
	};
	execute(args: unknown, exec: ToolExecution): Promise<unknown>;
	finalizeContent?(exec: ToolExecution, result: ToolExecutionResult): ContentBlock[] | undefined;
	isConcurrencySafe?(args: unknown): boolean;
	presentCall?(args: unknown): unknown;
	presentResult?(args: unknown, result: unknown): unknown;
	timeoutMs?: number;
};

export type DshContext = {
	on(
		event: string,
		listener: (...args: never[]) => unknown,
		options?: boolean | { prepend?: boolean },
	): () => void;
	effect?(callback: () => void | (() => void), label?: string): void;
	inject?(deps: readonly string[], callback: (ctx: DshContext) => void): void;
	tools: {
		get(name: string, scope?: unknown, toolSet?: unknown): ToolDefinition | undefined;
		register(definition: ToolDefinition, options?: { when?: unknown }): () => void;
		/** DSH 0.2.2 batch API: one batch, one outcome per call, in input order. */
		execute(input: {
			readonly calls: readonly { type: "tool-call"; id: string; name: string; arguments: string }[];
			readonly signal: AbortSignal;
			readonly agent?: unknown;
			readonly toolSet?: unknown;
		}): Promise<{ readonly results: readonly { callId: string; result: ToolExecutionResult }[] }>;
	};
	llm: {
		stream(options: Record<string, unknown>): AsyncIterable<{ type?: string; text?: string; [key: string]: unknown }>;
	};
	compaction?: {
		compactIfNeeded(agent: unknown, trigger: string, signal?: AbortSignal): Promise<unknown>;
		compactNow(agent: unknown, signal?: AbortSignal): Promise<unknown>;
	};
	spillStore?: {
		saveText(input: {
			owner: { sessionId: string };
			source: { kind: "tool"; toolName: string; callId: string; label: string };
			suggestedName: string;
			content: string;
		}): Promise<{ locator: string; bytes: number; retrievalHint: string }>;
	};
	tokenMeter?: { measure(input: unknown): number };
	systemPrompt?: {
		/** DSH 0.2.2 `PromptSection.text` is evaluated per assembly with that assembly's context. */
		section(section: {
			name: string;
			order: number;
			text: string | ((context: { scope?: unknown }) => string);
		}): () => void;
		getSectionOrder?(name: string): number;
	};
	agents?: { list(): DshAgent[]; get?(id: string): DshAgent | undefined };
	logger?: { warn(message: string): void; error?(error: unknown): void };
	get?(name: string): unknown;
};

export type DshAgent = {
	readonly id?: string;
	readonly ctx: DshContext;
	/** DSH `Agent.options` — the live provider/model route. */
	readonly options?: { readonly provider?: string; readonly model?: string };
	readonly session?: {
		readonly id?: string;
		/** DSH `Session.header` — validated creation metadata, including the absolute `cwd`. */
		readonly header?: { readonly cwd?: string };
		readonly provider?: string;
		readonly modelId?: string;
		readonly model?: unknown;
		append?(event: unknown): unknown;
	};
	whenIdle?(): Promise<void>;
	steer?(text: string): unknown;
	status?: string;
};

export function textOf(content: readonly ContentBlock[] | undefined): string {
	if (!content) return "";
	return content
		.filter((block): block is TextBlock => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

export function recordValue(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

export function agentFromPayload(payload: unknown): DshAgent | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const agent = (payload as { agent?: DshAgent }).agent;
	return agent && typeof agent === "object" && "ctx" in agent ? agent : undefined;
}

export function executionAgent(exec: ToolExecution): DshAgent | undefined {
	return exec.agent && typeof exec.agent === "object" ? exec.agent : undefined;
}

export function isAcceptDecision(decision: PostToolDecision): decision is Extract<PostToolDecision, { kind: "accept" }> {
	return decision.kind === "accept";
}

export function contentFromDecision(decision: PostToolDecision, result: ToolExecutionResult): ContentBlock[] | undefined {
	if (decision.kind !== "accept") return undefined;
	if ("value" in decision && decision.value !== undefined && decision.content === undefined) return undefined;
	if (decision.content) return decision.content;
	return result.content ? [...result.content] : undefined;
}

export function acceptContent(decision: PostToolDecision, content: ContentBlock[]): PostToolDecision {
	if (decision.kind === "block") return decision;
	return {
		kind: "accept",
		content,
		...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {},
	};
}

export function listenPostExecute(
	ctx: DshContext,
	listener: (exec: ToolExecution, result: ToolExecutionResult, decision: PostToolDecision) => Promise<PostToolDecision>,
	prepend = true,
): void {
	ctx.on(
		"tools/post-execute",
		((exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>) => {
			return (async () => {
				const decision = await next();
				try {
					return await listener(exec, result, decision);
				} catch {
					return decision;
				}
			})();
		}) as (...args: never[]) => unknown,
		{ prepend },
	);
}
