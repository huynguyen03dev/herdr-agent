// @amp-agent-mode {"key":"gemini-3.5-flash","label":"Gemini 3.5 Flash"}
// @amp-agent-mode {"key":"gpt-5.6-luna","label":"GPT 5.6 Luna"}
// @amp-agent-mode {"key":"glm-5.2","label":"GLM 5.2"}
import type { PluginAPI } from '@ampcode/plugin'

// Generic coding-agent prompt for "normal" model-pinned modes (not the Herdr
// director). Mirrors the style of baseten.ts so these modes feel like regular
// Amp sessions, just pinned to a specific model.
const GENERIC_PROMPT = `
You are a coding agent. Your job is to modify the user's codebase to satisfy
the latest request, then verify the result.

Prefer the smallest change that fully solves the requested behavior. Read the
files that define the behavior before editing them. Match the style, names, and
abstractions already used near the change. Run the narrowest check that can
catch likely mistakes, and broaden verification when the change affects shared
behavior. Report failed or skipped verification explicitly.
`.trim()

const RESTRICTED_TOOLS = {
	include: 'all' as const,
	exclude: [
		'oracle',
		'librarian',
		'Task',
		'finder',
		'painter',
		'parallel',
	] as const,
}

export default function (amp: PluginAPI) {
	if (!amp.experimental) {
		amp.logger.log('amp-models: experimental plugin API is not available.')
		return
	}

	const geminiFlash = amp.experimental.createAgent({
		name: 'gemini-3.5-flash',
		model: 'vertexai/gemini-3.5-flash',
		instructions: GENERIC_PROMPT,
		tools: RESTRICTED_TOOLS,
		reasoningEffort: 'medium',
	})

	amp.experimental.registerAgentMode({
		key: 'gemini-3.5-flash',
		label: 'Gemini 3.5 Flash',
		description: 'Normal coding mode on Gemini 3.5 Flash (1M ctx, fast).',
		color: '#22c55e',
		agent: geminiFlash.definition,
	})

	// Model id is not in show-agent-options, but providers can serve models
	// Amp hasn't pre-discovered (same as baseten.ts). If openai rejects this id
	// at call time, swap to a known id (e.g. openai/gpt-5.5).
	const gptLuna = amp.experimental.createAgent({
		name: 'gpt-5.6-luna',
		model: 'openai/gpt-5.6-luna',
		instructions: GENERIC_PROMPT,
		tools: RESTRICTED_TOOLS,
		reasoningEffort: 'max',
	})

	amp.experimental.registerAgentMode({
		key: 'gpt-5.6-luna',
		label: 'GPT 5.6 Luna',
		description: 'Normal coding mode on GPT-5.6 Luna (max reasoning).',
		color: '#a855f7',
		agent: gptLuna.definition,
	})

	// Model id is not in show-agent-options, but providers can serve models
	// Amp hasn't pre-discovered (same as baseten.ts). If openai rejects this id
	// at call time, swap to a known id (e.g. openai/gpt-5.5).
	const glm52 = amp.experimental.createAgent({
		name: 'glm-5.2',
		model: 'amp/glm-5.2',
		instructions: GENERIC_PROMPT,
		tools: RESTRICTED_TOOLS,
		reasoningEffort: 'medium',
	})

	amp.experimental.registerAgentMode({
		key: 'glm-5.2',
		label: 'GLM 5.2',
		description: 'Normal coding mode on amp/glm-5.2 (medium reasoning).',
		color: '#3b82f6',
		agent: glm52.definition,
	})
}
