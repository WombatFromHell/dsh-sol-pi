/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { delegatingName, FUSED_TOOLS, hasThenRunParameter, registerActionFusion } from "./action-fusion.ts";
import type { SolDshConfig } from "./config.ts";
import { Config } from "./config-schema.ts";
import { registerEvidencePreservingReducer } from "./epr.ts";
import type { DshContext } from "./host.ts";
import { registerObservationPack } from "./observation-pack.ts";
import { liveSolDshConfig } from "./settings.ts";

export const name = "dsh-sol-pi";

/** Required services. Optional ones (settings, compaction, spill, prompts) attach via inject. */
export const inject = ["tools", "llm"];

export { Config };
export type { SolDshConfig };

/**
 * Native DeepSeek Harness plugin. Named exports only — a default export would
 * drop `inject` in Cordis `unwrapExports`.
 */
export function apply(ctx: DshContext, config: SolDshConfig | Record<string, unknown> = {}): void {
	// Entry config is the settings document (id dsh-sol-pi). Live edits arrive
	// via Schemastery volatile refs — installSection was removed in 0.1.7.
	const source = liveSolDshConfig(config);

	// EPR must register first (inner prepend) so diagnostic logs reduce before
	// ObservationPack replaces them with a preview that looks "too small".
	registerEvidencePreservingReducer(ctx, () => source().evidencePreservingReducer);
	registerObservationPack(ctx, () => source().observationPack);
	registerActionFusion(ctx, () => source().actionFusion.enabled);
	// OCC overlaps dsh-vcc's compaction and its DSH 0.2.2 hooks (request-size meter)
	// are not ported, so it stays off by default and is not attached when enabled.
	// ponytail: port occ.ts against `llm/stream` usage before re-enabling.
	if (source().onlineContextCompact.enabled) {
		ctx.logger?.warn?.(
			"dsh-sol-pi: onlineContextCompact is not wired for DSH 0.2.2 (overlaps dsh-vcc compaction); ignoring it",
		);
	}

	ctx.inject?.(["systemPrompt"], (child) => {
		const prompt = child.systemPrompt;
		if (!prompt?.section) return;
		const order = prompt.getSectionOrder?.("TOOL_EDIT") ?? 800;
		prompt.section({
			name: "dsh-sol-pi",
			order,
			text: (context) => {
				const current = source();
				const parts = ["SoL (dsh-sol-pi) is active."];
				if (current.actionFusion.enabled) {
					// Per assembly scope: a peer plugin's agent-layer registration shadows
					// the fused global tool, so only names that actually accept `then_run`
					// for this agent are advertised — the fused name or sol-pi's delegating variant.
					const names = FUSED_TOOLS.flatMap((name) =>
						[name, delegatingName(name)].filter((candidate) =>
							hasThenRunParameter(ctx.tools.get(candidate, context?.scope)?.parameters ?? {}),
						),
					);
					if (names.length > 0) {
						const variants = names.filter((name) => name.endsWith("_and_run"));
						parts.push(
							`${names.join(" and ")} ${names.length === 1 ? "accepts" : "accept"} optional then_run {command, timeout?}. After a successful file mutation, you MUST pass then_run for the immediate format/test/build instead of a later bash call.`,
						);
						if (variants.length > 0) {
							parts.push(
								`${variants.join(" and ")} take the same arguments as ${variants.map((name) => name.replace("_and_run", "")).join(" and ")} plus then_run.`,
							);
						}
					}
				}
				if (current.observationPack.enabled && current.observationPack.mode === "immediate") {
					parts.push(
						"Oversized command dumps (go test, make, fused then_run) are stored as a preview; read, grep, and git diff/show stay in full. Retrieve a dump with read/grep on the given path or locator.",
					);
				}
				if (current.evidencePreservingReducer.enabled) {
					parts.push(
						"Long diagnostic logs may be replaced with a verified evidence receipt pointing at a local archive.",
					);
				}
				return parts.join(" ");
			},
		});
	});
}
