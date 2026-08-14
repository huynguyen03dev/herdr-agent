// @amp-agent-mode {"key":"herder-root","label":"herder root"}
// @amp-agent-mode {"key":"herder-root-luna","label":"herder root (Luna)"}
// @amp-agent-mode {"key":"herder-root-sol-high","label":"herder root (Sol high)"}
// @amp-agent-mode {"key":"herder-root-sol-med","label":"herder root (Sol med)"}
// @amp-agent-mode {"key":"herder-root-sol-low","label":"herder root (Sol low)"}
import type { PluginAPI } from '@ampcode/plugin'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Resolve the Herdr home once at plugin load so the profile is read fresh on
// every plugin reload (no absolute /home/<name> baked in). Mirrors the
// ${HERDER_AGENT_HOME:-$HOME/herder-agent} convention used by bin/herdr-agent.
const HERDER_HOME = process.env.HERDER_AGENT_HOME ?? join(homedir(), 'herder-agent')
const ROOT_PROFILE = join(HERDER_HOME, 'profiles/root_instruction.md')
const INSTRUCTIONS = readFileSync(ROOT_PROFILE, 'utf8')
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
		amp.logger.log('herder-root: experimental plugin API is not available.')
		return
	}

	const root = amp.experimental.createAgent({
		name: 'herder-root',
		model: 'amp/glm-5.3',
		instructions: INSTRUCTIONS,
		tools: RESTRICTED_TOOLS,
		reasoningEffort: 'high',
	})

	amp.experimental.registerAgentMode({
		key: 'herder-root',
		label: 'herder root',
		description: 'Herdr director — loads profiles/root_instruction.md (the ONLY Herdr-aware profile).',
		color: '#f59e0b',
		agent: root.definition,
	})

	// Same director profile on GPT-5.6 Luna (max reasoning). Use when you want
	// a stronger director model than GLM-5.3. Requires a non-ChatGPT OpenAI
	// provider route (API key), since the ChatGPT subscription rejects Luna.
	const rootLuna = amp.experimental.createAgent({
		name: 'herder-root-luna',
		model: 'openai/gpt-5.6-luna',
		instructions: INSTRUCTIONS,
		tools: RESTRICTED_TOOLS,
		reasoningEffort: 'max',
	})

	amp.experimental.registerAgentMode({
		key: 'herder-root-luna',
		label: 'herder root (Luna)',
		description: 'Herdr director on GPT-5.6 Luna — same profile as herder root, stronger model.',
		color: '#a855f7',
		agent: rootLuna.definition,
	})

	// GPT-5.6 Sol — verified-working id. Three reasoning tiers so you can pick
	// cheap-and-fast (low), balanced (medium), or deep (high) for the director role.
	const rootSolHigh = amp.experimental.createAgent({
		name: 'herder-root-sol-high',
		model: 'openai/gpt-5.6-sol',
		instructions: INSTRUCTIONS,
		tools: RESTRICTED_TOOLS,
		reasoningEffort: 'high',
	})

	amp.experimental.registerAgentMode({
		key: 'herder-root-sol-high',
		label: 'herder root (Sol high)',
		description: 'Herdr director on GPT-5.6 Sol (high reasoning).',
		color: '#0ea5e9',
		agent: rootSolHigh.definition,
	})

	const rootSolMed = amp.experimental.createAgent({
		name: 'herder-root-sol-med',
		model: 'openai/gpt-5.6-sol',
		instructions: INSTRUCTIONS,
		tools: RESTRICTED_TOOLS,
		reasoningEffort: 'medium',
	})

	amp.experimental.registerAgentMode({
		key: 'herder-root-sol-med',
		label: 'herder root (Sol med)',
		description: 'Herdr director on GPT-5.6 Sol (medium reasoning).',
		color: '#0ea5e9',
		agent: rootSolMed.definition,
	})

	const rootSolLow = amp.experimental.createAgent({
		name: 'herder-root-sol-low',
		model: 'openai/gpt-5.6-sol',
		instructions: INSTRUCTIONS,
		tools: RESTRICTED_TOOLS,
		reasoningEffort: 'low',
	})

	amp.experimental.registerAgentMode({
		key: 'herder-root-sol-low',
		label: 'herder root (Sol low)',
		description: 'Herdr director on GPT-5.6 Sol (low reasoning, fastest/cheapest).',
		color: '#64748b',
		agent: rootSolLow.definition,
	})
}
