/**
 * Ask Tool
 *
 * Asks single- or multi-select questions with optional branching support.
 * If no branching metadata is provided, questions are asked in order.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type QuestionType = "single" | "multi";
export type BranchMatch = "any" | "all";

export interface BranchOptionInput {
	value: string;
	label: string;
	description?: string;
	nextQuestionId?: string | null;
}

export interface BranchRuleInput {
	values: string[];
	nextQuestionId?: string | null;
	match?: BranchMatch;
}

export interface BranchQuestionInput {
	id: string;
	label?: string;
	prompt: string;
	type: QuestionType;
	options: BranchOptionInput[];
	allowOther?: boolean;
	nextQuestionId?: string | null;
	branches?: BranchRuleInput[];
}

interface BranchOption {
	value: string;
	label: string;
	description?: string;
	nextQuestionId?: string | null;
}

interface BranchRule {
	values: string[];
	nextQuestionId?: string | null;
	match: BranchMatch;
}

interface BranchQuestion {
	id: string;
	label: string;
	prompt: string;
	type: QuestionType;
	options: BranchOption[];
	allowOther: boolean;
	nextQuestionId?: string | null;
	branches: BranchRule[];
}

type RenderOption = BranchOption & { isOther?: boolean; isContinue?: boolean };

const OTHER_OPTION_VALUE = "__other__";
const CONTINUE_OPTION_VALUE = "__continue__";

export interface Selection {
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface Answer {
	id: string;
	type: QuestionType;
	selections: Selection[];
	asked: boolean;
}

interface BranchQuestionResult {
	questions: BranchQuestion[];
	answers: Answer[];
	askedQuestionIds: string[];
	cancelled: boolean;
}

function normalizeNextQuestionId(value: string | null | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeQuestions(questions: BranchQuestionInput[]): BranchQuestion[] {
	return questions.map((question, index) => ({
		id: question.id,
		label: question.label ?? `Q${index + 1}`,
		prompt: question.prompt,
		type: question.type,
		options: question.options.map((option) => ({
			value: option.value,
			label: option.label,
			description: option.description,
			nextQuestionId: normalizeNextQuestionId(option.nextQuestionId),
		})),
		allowOther: true,
		nextQuestionId: normalizeNextQuestionId(question.nextQuestionId),
		branches: (question.branches ?? []).map((branch) => ({
			values: Array.from(new Set(branch.values.map((value) => value.trim()).filter((value) => value.length > 0))),
			nextQuestionId: normalizeNextQuestionId(branch.nextQuestionId),
			match: branch.match ?? "any",
		})),
	}));
}

function selectionsMatch(a: Selection, b: Selection): boolean {
	return a.value === b.value && a.wasCustom === b.wasCustom;
}

function toggleSelections(selections: Selection[], selection: Selection): Selection[] {
	const existingIndex = selections.findIndex((item) => selectionsMatch(item, selection));
	if (existingIndex >= 0) {
		return [...selections.slice(0, existingIndex), ...selections.slice(existingIndex + 1)];
	}
	return [...selections, selection];
}

function buildSelectionsWithCustom(
	questionType: QuestionType,
	selections: Selection[],
	customText: string,
): Selection[] {
	const trimmed = customText.trim();
	const nonCustom = selections.filter((item) => !item.wasCustom);
	if (!trimmed) {
		return nonCustom;
	}
	const customSelection: Selection = {
		value: trimmed,
		label: trimmed,
		wasCustom: true,
	};
	if (questionType === "single") {
		return [customSelection];
	}
	return [...nonCustom, customSelection];
}

function getCustomOptionDisplay(
	customText: string,
	placeholder: string,
	isSelected: boolean,
): { text: string; isPlaceholder: boolean; showCursor: boolean } {
	if (customText.length > 0) {
		return { text: customText, isPlaceholder: false, showCursor: isSelected };
	}
	if (isSelected) {
		return { text: "", isPlaceholder: false, showCursor: true };
	}
	return { text: placeholder, isPlaceholder: true, showCursor: false };
}

function parseNumberKey(data: string): number | null {
	if (data.length === 1 && data >= "0" && data <= "9") {
		return Number.parseInt(data, 10);
	}

	const match = data.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/);
	if (!match) return null;

	const codepoint = Number.parseInt(match[1]!, 10);
	const modifierValue = match[2] ? Number.parseInt(match[2], 10) : 1;
	if (modifierValue !== 1) return null;

	if (codepoint >= 48 && codepoint <= 57) {
		return codepoint - 48;
	}

	return null;
}


function buildSequentialNextById(questions: BranchQuestion[]): Map<string, string | null> {
	const map = new Map<string, string | null>();
	for (let i = 0; i < questions.length; i++) {
		const next = i < questions.length - 1 ? questions[i + 1]?.id ?? null : null;
		map.set(questions[i].id, next);
	}
	return map;
}

function collectEdges(
	question: BranchQuestion,
	sequentialNextById: Map<string, string | null>,
): string[] {
	const edges = new Set<string>();

	if (question.nextQuestionId === undefined) {
		const sequential = sequentialNextById.get(question.id);
		if (sequential) edges.add(sequential);
	} else if (question.nextQuestionId) {
		edges.add(question.nextQuestionId);
	}

	for (const option of question.options) {
		if (option.nextQuestionId) edges.add(option.nextQuestionId);
	}

	for (const branch of question.branches) {
		if (branch.nextQuestionId) edges.add(branch.nextQuestionId);
	}

	return [...edges];
}

function hasCycleFrom(startId: string, edges: Map<string, string[]>): boolean {
	const visiting = new Set<string>();
	const visited = new Set<string>();

	function visit(questionId: string): boolean {
		if (visiting.has(questionId)) return true;
		if (visited.has(questionId)) return false;

		visiting.add(questionId);
		for (const nextId of edges.get(questionId) ?? []) {
			if (visit(nextId)) return true;
		}
		visiting.delete(questionId);
		visited.add(questionId);
		return false;
	}

	return visit(startId);
}

function validateQuestionGraph(
	questions: BranchQuestion[],
	startQuestionId: string,
): string | null {
	const questionById = new Map<string, BranchQuestion>();

	for (const question of questions) {
		if (!question.id.trim()) {
			return "Error: Every question must have a non-empty id";
		}
		if (questionById.has(question.id)) {
			return `Error: Duplicate question id \"${question.id}\"`;
		}
		questionById.set(question.id, question);
	}

	if (!questionById.has(startQuestionId)) {
		return `Error: startQuestionId \"${startQuestionId}\" does not exist`;
	}

	for (const question of questions) {
		if (question.nextQuestionId && !questionById.has(question.nextQuestionId)) {
			return `Error: Question \"${question.id}\" points to unknown nextQuestionId \"${question.nextQuestionId}\"`;
		}
		for (const option of question.options) {
			if (option.nextQuestionId && !questionById.has(option.nextQuestionId)) {
				return `Error: Question \"${question.id}\" option \"${option.value}\" points to unknown nextQuestionId \"${option.nextQuestionId}\"`;
			}
		}
		for (const branch of question.branches) {
			if (branch.values.length === 0) {
				return `Error: Question \"${question.id}\" has a branch rule with no values`;
			}
			if (branch.nextQuestionId && !questionById.has(branch.nextQuestionId)) {
				return `Error: Question \"${question.id}\" has branch rule pointing to unknown nextQuestionId \"${branch.nextQuestionId}\"`;
			}
		}
	}

	const sequentialNextById = buildSequentialNextById(questions);
	const edges = new Map<string, string[]>();
	for (const question of questions) {
		edges.set(question.id, collectEdges(question, sequentialNextById));
	}

	if (hasCycleFrom(startQuestionId, edges)) {
		return "Error: Branch graph has a cycle reachable from startQuestionId. Use a DAG (no loops).";
	}

	return null;
}

function selectedValueTokens(selections: Selection[]): Set<string> {
	const tokens = new Set<string>();
	for (const selection of selections) {
		if (selection.wasCustom) {
			tokens.add(OTHER_OPTION_VALUE);
		} else {
			tokens.add(selection.value);
		}
	}
	return tokens;
}

function matchesBranch(rule: BranchRule, selectedTokens: Set<string>): boolean {
	if (rule.match === "all") {
		return rule.values.every((value) => selectedTokens.has(value));
	}
	return rule.values.some((value) => selectedTokens.has(value));
}

function resolveNextQuestionId(
	question: BranchQuestion,
	selections: Selection[],
	sequentialNextById: Map<string, string | null>,
): string | null {
	const selectedTokens = selectedValueTokens(selections);

	for (const branch of question.branches) {
		if (matchesBranch(branch, selectedTokens)) {
			return branch.nextQuestionId ?? null;
		}
	}

	for (const option of question.options) {
		if (!selectedTokens.has(option.value)) continue;
		if (option.nextQuestionId !== undefined) {
			return option.nextQuestionId ?? null;
		}
	}

	if (question.nextQuestionId !== undefined) {
		return question.nextQuestionId ?? null;
	}

	return sequentialNextById.get(question.id) ?? null;
}

function errorResult(message: string, questions: BranchQuestion[] = []) {
	return {
		content: [{ type: "text", text: message }],
		details: {
			questions,
			answers: [],
			askedQuestionIds: [],
			cancelled: true,
		} as BranchQuestionResult,
	};
}

export default function askBranchedQuestions(pi: ExtensionAPI) {
	const OptionSchema = Type.Object({
		value: Type.String({ description: "The value returned when selected" }),
		label: Type.String({ description: "Display label for the option" }),
		description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
		nextQuestionId: Type.Optional(
			Type.Union([
				Type.String({ description: "Optional next question id when this option is selected" }),
				Type.Null({ description: "Use null to end the flow immediately" }),
			]),
		),
	});

	const BranchRuleSchema = Type.Object({
		values: Type.Array(Type.String({ description: "Option values that trigger this branch" }), {
			description:
				"Use option values. Use '__other__' to match custom typed answers from 'Type something'.",
			minItems: 1,
		}),
		nextQuestionId: Type.Optional(
			Type.Union([
				Type.String({ description: "Question id to ask next when this rule matches" }),
				Type.Null({ description: "Use null to end the flow immediately" }),
			]),
		),
		match: Type.Optional(
			StringEnum(["any", "all"] as const, {
				description:
					"'any' (default): branch when any value is selected. 'all': branch when all values are selected.",
			}),
		),
	});

	const QuestionSchema = Type.Object({
		id: Type.String({ description: "Unique identifier for this question" }),
		label: Type.Optional(
			Type.String({ description: "Short label for progress tabs (defaults to Q1, Q2...)" }),
		),
		prompt: Type.String({ description: "Question prompt shown to the user" }),
		type: StringEnum(["single", "multi"] as const, { description: "single or multi-select" }),
		options: Type.Array(OptionSchema, { description: "Options to choose from" }),
		allowOther: Type.Optional(
			Type.Boolean({ description: "Ignored: custom answer option is always shown" }),
		),
		nextQuestionId: Type.Optional(
			Type.Union([
				Type.String({ description: "Fallback next question id for this question" }),
				Type.Null({ description: "Use null to end the flow after this question" }),
			]),
		),
		branches: Type.Optional(
			Type.Array(BranchRuleSchema, {
				description:
					"Optional branch rules evaluated in order. First matching rule wins before option-level and question-level fallbacks.",
			}),
		),
	});

	const AskBranchedQuestionsParams = Type.Object({
		questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
		startQuestionId: Type.Optional(
			Type.String({
				description: "Optional first question id. Defaults to the first question in the array.",
			}),
		),
	});

	pi.registerTool({
		name: "branch-ask",
		exposure: "model-only",
		label: "Branch Ask",
		description:
			"Ask the user single - or multi-select questions with branching. Use branches when your next question depends on user's previous question answer. Without branch metadata, it behaves like a normal sequential questionnaire.",
		parameters: AskBranchedQuestionsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}

			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			const questions = normalizeQuestions(params.questions);
			const startQuestionId = (params.startQuestionId?.trim() || questions[0]?.id) as string | undefined;
			if (!startQuestionId) {
				return errorResult("Error: Could not determine start question", questions);
			}

			const validationError = validateQuestionGraph(questions, startQuestionId);
			if (validationError) {
				return errorResult(validationError, questions);
			}

			const questionById = new Map(questions.map((question) => [question.id, question]));
			const sequentialNextById = buildSequentialNextById(questions);

			const result = await ctx.ui.custom<BranchQuestionResult>((tui, theme, _kb, done) => {
				const pathQuestionIds: string[] = [startQuestionId];
				const optionIndexByQuestionId = new Map<string, number>();

				let currentPathIndex = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let warningMessage: string | null = null;
				let cachedLines: string[] | undefined;
				let suppressEditorChange = false;

				const answers = new Map<string, Selection[]>();
				const customInputs = new Map<string, string>();

				const editorTheme = {
					borderColor: (s: string) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function setEditorText(text: string) {
					suppressEditorChange = true;
					editor.setText(text);
					suppressEditorChange = false;
				}

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					const askedQuestionIds = [...pathQuestionIds];
					const askedSet = new Set(askedQuestionIds);
					done({
						questions,
						answers: questions.map((q) => ({
							id: q.id,
							type: q.type,
							selections: answers.get(q.id) ?? [],
							asked: askedSet.has(q.id),
						})),
						askedQuestionIds,
						cancelled,
					});
				}

				function currentQuestionId(): string | undefined {
					return pathQuestionIds[currentPathIndex];
				}

				function currentQuestion(): BranchQuestion | undefined {
					const questionId = currentQuestionId();
					if (!questionId) return undefined;
					return questionById.get(questionId);
				}

				function currentOptions(question: BranchQuestion): RenderOption[] {
					const options: RenderOption[] = [...question.options];
					if (question.allowOther) {
						options.push({
							value: OTHER_OPTION_VALUE,
							label: "Type something.",
							isOther: true,
						});
					}
					if (question.type === "multi") {
						options.push({
							value: CONTINUE_OPTION_VALUE,
							label: "Continue",
							isContinue: true,
						});
					}
					return options;
				}

				function selectionsFor(questionId: string): Selection[] {
					return answers.get(questionId) ?? [];
				}

				function customSelectionFor(questionId: string): Selection | undefined {
					return selectionsFor(questionId).find((selection) => selection.wasCustom);
				}

				function hasAnswer(question: BranchQuestion): boolean {
					return selectionsFor(question.id).length > 0;
				}

				function clearWarning() {
					if (warningMessage) {
						warningMessage = null;
					}
				}

				function setWarning(message: string) {
					warningMessage = message;
					refresh();
				}

				function applyCustomInput(question: BranchQuestion, text: string) {
					customInputs.set(question.id, text);
					const nextSelections = buildSelectionsWithCustom(question.type, selectionsFor(question.id), text);
					answers.set(question.id, nextSelections);
				}

				function syncEditorForQuestion(question: BranchQuestion | undefined) {
					if (!question || !question.allowOther) {
						inputQuestionId = null;
						setEditorText("");
						return;
					}
					inputQuestionId = question.id;
					const existing = customInputs.get(question.id) ?? customSelectionFor(question.id)?.label ?? "";
					if (!customInputs.has(question.id) && existing) {
						customInputs.set(question.id, existing);
					}
					setEditorText(existing);
				}

				function setOptionIndex(nextIndex: number, question: BranchQuestion) {
					const options = currentOptions(question);
					optionIndex = Math.max(0, Math.min(options.length - 1, nextIndex));
					optionIndexByQuestionId.set(question.id, optionIndex);
					const selectedOption = options[optionIndex];
					inputMode = selectedOption?.isOther === true;
					if (inputMode) {
						syncEditorForQuestion(question);
					} else {
						inputQuestionId = null;
					}
				}

				function restoreOptionIndex(question: BranchQuestion) {
					const savedIndex = optionIndexByQuestionId.get(question.id) ?? 0;
					setOptionIndex(savedIndex, question);
				}

				function setSingleAnswer(questionId: string, selection: Selection) {
					answers.set(questionId, [selection]);
				}

				function toggleSelection(questionId: string, selection: Selection) {
					const currentSelections = selectionsFor(questionId);
					const nextSelections = toggleSelections(currentSelections, selection);
					answers.set(questionId, nextSelections);
				}

				function buildOptionSelection(option: RenderOption, index: number): Selection {
					return {
						value: option.value,
						label: option.label,
						wasCustom: false,
						index: index + 1,
					};
				}

				function clearPathFrom(startIndex: number) {
					const removedIds = pathQuestionIds.splice(startIndex);
					for (const removedId of removedIds) {
						answers.delete(removedId);
						customInputs.delete(removedId);
						optionIndexByQuestionId.delete(removedId);
					}
				}

				function advanceFromQuestion(question: BranchQuestion) {
					const selections = selectionsFor(question.id);
					if (selections.length === 0) {
						setWarning("Please select at least one answer before continuing.");
						return;
					}

					const nextQuestionId = resolveNextQuestionId(question, selections, sequentialNextById);
					if (!nextQuestionId) {
						clearPathFrom(currentPathIndex + 1);
						submit(false);
						return;
					}

					if (!questionById.has(nextQuestionId)) {
						setWarning(`Unknown next question id: ${nextQuestionId}`);
						return;
					}

					if (pathQuestionIds.slice(0, currentPathIndex + 1).includes(nextQuestionId)) {
						setWarning(`Branch loop detected at \"${nextQuestionId}\". Adjust branch rules to avoid loops.`);
						return;
					}

					const nextPathIndex = currentPathIndex + 1;
					const existingNextQuestionId = pathQuestionIds[nextPathIndex];

					if (existingNextQuestionId === nextQuestionId) {
						currentPathIndex = nextPathIndex;
					} else {
						clearPathFrom(nextPathIndex);
						pathQuestionIds.push(nextQuestionId);
						currentPathIndex = pathQuestionIds.length - 1;
					}

					const nextQuestion = currentQuestion();
					if (nextQuestion) {
						restoreOptionIndex(nextQuestion);
					}
					inputMode = false;
					inputQuestionId = null;
					clearWarning();
					refresh();
				}

				function goBack() {
					if (currentPathIndex === 0) return;
					currentPathIndex -= 1;
					const question = currentQuestion();
					if (!question) return;
					restoreOptionIndex(question);
					inputMode = false;
					inputQuestionId = null;
					clearWarning();
					refresh();
				}

				function goForward() {
					if (currentPathIndex >= pathQuestionIds.length - 1) return;
					currentPathIndex += 1;
					const question = currentQuestion();
					if (!question) return;
					restoreOptionIndex(question);
					inputMode = false;
					inputQuestionId = null;
					clearWarning();
					refresh();
				}

				function selectSingleOption(question: BranchQuestion, option: RenderOption, index: number) {
					setSingleAnswer(question.id, buildOptionSelection(option, index));
					clearWarning();
					advanceFromQuestion(question);
				}

				function toggleMultiOption(question: BranchQuestion, option: RenderOption, index: number) {
					toggleSelection(question.id, buildOptionSelection(option, index));
					clearWarning();
					refresh();
				}

				function activateOtherOption(question: BranchQuestion, input?: string) {
					inputMode = true;
					syncEditorForQuestion(question);
					if (input !== undefined) {
						editor.handleInput(input);
					}
					refresh();
				}

				editor.onChange = (value: string) => {
					if (suppressEditorChange) return;
					if (!inputQuestionId) return;
					const question = questionById.get(inputQuestionId);
					if (!question) return;
					applyCustomInput(question, value);
					clearWarning();
					refresh();
				};

				editor.onSubmit = (value: string) => {
					if (!inputQuestionId) return;
					const question = questionById.get(inputQuestionId);
					if (!question) return;

					const trimmed = value.trim();
					if (!trimmed && question.type === "single") {
						applyCustomInput(question, "");
						setWarning("Please type an answer or pick one of the listed options.");
						refresh();
						return;
					}

					applyCustomInput(question, value);
					inputMode = false;
					inputQuestionId = null;
					clearWarning();

					if (question.type === "single") {
						advanceFromQuestion(question);
						return;
					}

					refresh();
				};

				const initialQuestion = currentQuestion();
				if (initialQuestion) {
					restoreOptionIndex(initialQuestion);
				}

				function handleInput(data: string) {
					const question = currentQuestion();
					if (!question) {
						submit(true);
						return;
					}

					if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
						goBack();
						return;
					}

					if (matchesKey(data, Key.right)) {
						goForward();
						return;
					}

					const options = currentOptions(question);
					const selectedOption = options[optionIndex];

					if (inputMode && selectedOption?.isOther && inputQuestionId === question.id) {
						if (matchesKey(data, Key.enter)) {
							editor.handleInput(data);
							return;
						}
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							clearWarning();
							refresh();
							return;
						}
						if (matchesKey(data, Key.up)) {
							setOptionIndex(optionIndex - 1, question);
							clearWarning();
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							setOptionIndex(optionIndex + 1, question);
							clearWarning();
							refresh();
							return;
						}

						editor.handleInput(data);
						return;
					}

					if (matchesKey(data, Key.up)) {
						setOptionIndex(optionIndex - 1, question);
						clearWarning();
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						setOptionIndex(optionIndex + 1, question);
						clearWarning();
						refresh();
						return;
					}

					const numberKey = parseNumberKey(data);
					if (numberKey !== null) {
						const targetIndex = numberKey - 1;
						if (targetIndex >= 0 && targetIndex < options.length) {
							setOptionIndex(targetIndex, question);
							const selected = options[targetIndex];

							if (selected.isContinue) {
								advanceFromQuestion(question);
								return;
							}
							if (selected.isOther) {
								activateOtherOption(question);
								return;
							}
							if (question.type === "single") {
								selectSingleOption(question, selected, targetIndex);
								return;
							}

							clearWarning();
							refresh();
							return;
						}
					}

					if (matchesKey(data, Key.enter)) {
						if (selectedOption.isContinue) {
							advanceFromQuestion(question);
							return;
						}
						if (selectedOption.isOther) {
							activateOtherOption(question);
							return;
						}
						if (question.type === "single") {
							selectSingleOption(question, selectedOption, optionIndex);
							return;
						}
						advanceFromQuestion(question);
						return;
					}

					if (
						question.type === "multi" &&
						matchesKey(data, Key.space) &&
						!selectedOption.isOther &&
						!selectedOption.isContinue
					) {
						toggleMultiOption(question, selectedOption, optionIndex);
						return;
					}

					if (matchesKey(data, Key.escape)) {
						submit(true);
						return;
					}

					if (selectedOption.isOther) {
						activateOtherOption(question, data);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const question = currentQuestion();
					if (!question) {
						cachedLines = lines;
						return lines;
					}
					const maxWidth = Math.min(width, 100);

					const addLine = (s: string) => lines.push(truncateToWidth(s, maxWidth));
					const addWrapped = (text: string, indent = "") => {
						const indentWidth = visibleWidth(indent);
						const wrapWidth = Math.max(1, maxWidth - indentWidth);
						const wrapped = wrapTextWithAnsi(text, wrapWidth);
						for (const line of wrapped) {
							addLine(indent + line);
						}
					};
					const addWrappedWithPrefix = (prefix: string, text: string, continuationPrefix?: string) => {
						const prefixWidth = visibleWidth(prefix);
						const wrapWidth = Math.max(1, maxWidth - prefixWidth);
						const wrapped = wrapTextWithAnsi(text, wrapWidth);
						const continuation = continuationPrefix ?? " ".repeat(prefixWidth);
						wrapped.forEach((line, index) => {
							addLine((index === 0 ? prefix : continuation) + line);
						});
					};

					const renderPath = () => {
						const arrow = theme.fg("dim", "→");
						const hiddenToken = theme.fg("dim", "…");
						const progressToken = theme.fg(
							"dim",
							`${currentPathIndex + 1}/${Math.max(1, pathQuestionIds.length)}`,
						);
						const maxLabelWidth = 18;

						const formatLabel = (label: string) => {
							if (visibleWidth(label) <= maxLabelWidth) return label;
							if (maxLabelWidth <= 1) return "…";
							return `${truncateToWidth(label, maxLabelWidth - 1)}…`;
						};

						const tabTokens = pathQuestionIds.map((pathId, index) => {
							const pathQuestion = questionById.get(pathId);
							const label = formatLabel(pathQuestion?.label ?? pathId);
							const isActive = index === currentPathIndex;
							const isAnswered = pathQuestion ? hasAnswer(pathQuestion) : false;
							const marker = isAnswered ? "■" : "□";
							const text = ` ${marker} ${label} `;
							return isActive
								? theme.bg("selectedBg", theme.fg("text", text))
								: theme.fg(isAnswered ? "success" : "muted", text);
						});

						const buildPathTokenLine = (start: number, end: number) => {
							const tokens: string[] = [];
							if (start > 0) {
								tokens.push(hiddenToken);
							}
							for (let i = start; i <= end; i++) {
								tokens.push(tabTokens[i]!);
							}
							if (end < tabTokens.length - 1) {
								tokens.push(hiddenToken);
							}
							return tokens.join(` ${arrow} `);
						};

						const buildLine = (start: number, end: number, includeProgress: boolean) => {
							const pathLine = buildPathTokenLine(start, end);
							if (!includeProgress) {
								return ` ${pathLine}`;
							}
							return ` ${pathLine}  ${progressToken}`;
						};

						let start = Math.min(Math.max(currentPathIndex, 0), Math.max(tabTokens.length - 1, 0));
						let end = start;
						let includeProgress = true;

						if (visibleWidth(buildLine(start, end, includeProgress)) > maxWidth) {
							includeProgress = false;
						}

						while (true) {
							const candidates: Array<{ start: number; end: number; width: number }> = [];
							if (start > 0) {
								const candidateWidth = visibleWidth(buildLine(start - 1, end, includeProgress));
								candidates.push({ start: start - 1, end, width: candidateWidth });
							}
							if (end < tabTokens.length - 1) {
								const candidateWidth = visibleWidth(buildLine(start, end + 1, includeProgress));
								candidates.push({ start, end: end + 1, width: candidateWidth });
							}

							if (candidates.length === 0) break;
							candidates.sort((a, b) => a.width - b.width);

							const next = candidates.find((candidate) => candidate.width <= maxWidth);
							if (!next) break;

							start = next.start;
							end = next.end;
						}

						addLine(buildLine(start, end, includeProgress));
					};

					const renderQuestion = (current: BranchQuestion) => {
						const options = currentOptions(current);
						const selections = selectionsFor(current.id);
						const selectedValues = new Set(
							selections.filter((selection) => !selection.wasCustom).map((selection) => selection.value),
						);
						const customSelection = selections.find((selection) => selection.wasCustom);
						const customInput = customInputs.get(current.id) ?? customSelection?.label ?? "";
						const isCustomSelected = Boolean(customInput.trim());

						const renderDescription = (description?: string) => {
							if (description) {
								addWrapped(theme.fg("muted", description), "     ");
							}
						};

						addWrapped(theme.fg("text", current.prompt), " ");
						lines.push("");

						for (let i = 0; i < options.length; i++) {
							const option = options[i];
							const selected = i === optionIndex;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";

							if (option.isContinue) {
								const canContinue = hasAnswer(current);
								const label = `${i + 1}. ${option.label}`;
								const color = selected ? "accent" : canContinue ? "success" : "dim";
								addWrappedWithPrefix(prefix, theme.fg(color, label));
								continue;
							}

							const chosen = option.isOther ? isCustomSelected : selectedValues.has(option.value);
							const box = current.type === "multi" ? `[${chosen ? "x" : " "}] ` : "";

							if (option.isOther) {
								const display = getCustomOptionDisplay(customInput, option.label, selected);
								const cursor = display.showCursor ? "│" : "";
								const textBody = display.text ? `${display.text}${cursor ? `${cursor}` : ""}` : cursor;
								const label = `${i + 1}. ${textBody}`.trimEnd();
								const line = `${box}${label}`;

								let colored = "";
								if (selected) {
									colored = theme.fg("accent", line);
								} else if (display.isPlaceholder) {
									const prefixText = theme.fg("text", `${box}${i + 1}. `);
									const placeholderText = theme.fg("muted", display.text);
									colored = `${prefixText}${placeholderText}`;
								} else {
									colored = theme.fg("text", line);
								}

								addWrappedWithPrefix(prefix, colored);
								renderDescription(option.description);
								continue;
							}

							const label = `${i + 1}. ${option.label}`;
							const line = `${box}${label}`;
							const color = selected ? "accent" : "text";
							addWrappedWithPrefix(prefix, theme.fg(color, line));
							renderDescription(option.description);
						}
					};

					const renderHelp = () => {
						if (inputMode) {
							addWrapped(theme.fg("dim", " Type to edit • Enter to confirm • ←/→ navigate • Esc to stop typing"), " ");
							return;
						}
						if (question.type === "multi") {
							addWrapped(
								theme.fg(
									"dim",
									" ↑↓ select • Space toggle • Enter continue • 1-9 jump • ←/→ navigate • Esc cancel",
								),
								" ",
							);
							return;
						}
						addWrapped(theme.fg("dim", " ↑↓ select • Enter/1-9 choose • ←/→ navigate • Esc cancel"), " ");
					};

					addLine(theme.fg("accent", "─".repeat(maxWidth)));
					renderPath();
					lines.push("");
					renderQuestion(question);

					if (warningMessage) {
						lines.push("");
						addWrapped(theme.fg("warning", ` ${warningMessage}`));
					}

					lines.push("");
					renderHelp();
					addLine(theme.fg("accent", "─".repeat(maxWidth)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: result,
				};
			}

			const summaryLines = result.answers.map((answer) => {
				if (!answer.asked) {
					return `${answer.id}: (not asked)`;
				}
				if (answer.selections.length === 0) {
					return `${answer.id}: (no selection)`;
				}
				const labels = answer.selections.map((selection) => {
					if (selection.wasCustom) return `wrote: ${selection.label}`;
					if (selection.index) return `${selection.index}. ${selection.label}`;
					return selection.label;
				});
				return `${answer.id}: ${labels.join(", ")}`;
			});

			return {
				content: [{ type: "text", text: summaryLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme) {
			const qs = (args.questions as BranchQuestion[]) || [];
			const count = qs.length;
			const labels = qs.map((question) => question.label || question.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("branch-ask "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as BranchQuestionResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				if (!answer.asked) {
					return `${theme.fg("dim", "•")} ${theme.fg("muted", answer.id)}: ${theme.fg("dim", "(not asked)")}`;
				}
				if (answer.selections.length === 0) {
					return `${theme.fg("warning", "⚠")} ${theme.fg("accent", answer.id)}: (no selection)`;
				}
				const selectionText = answer.selections
					.map((selection) => {
						if (selection.wasCustom) return `${theme.fg("muted", "(wrote) ")}${selection.label}`;
						const display = selection.index ? `${selection.index}. ${selection.label}` : selection.label;
						return display;
					})
					.join(", ");
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${selectionText}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
