// Self-contained edit helpers - no dependency on minified variable names
// Uses standard Node APIs via dynamic import (ES module compatible)

const _claudeFs = await import("node:fs");
const _claudePath = await import("node:path");

// --- Utility Functions (replicate internal helpers) ---

function _claudeGetEncoding(filePath) {
	// Check for BOM markers
	try {
		const fd = _claudeFs.openSync(filePath, "r");
		const buf = Buffer.alloc(4);
		_claudeFs.readSync(fd, buf, 0, 4, 0);
		_claudeFs.closeSync(fd);

		// UTF-8 BOM
		if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf8";
		// UTF-16 LE BOM
		if (buf[0] === 0xff && buf[1] === 0xfe) return "utf16le";
		// UTF-16 BE BOM
		if (buf[0] === 0xfe && buf[1] === 0xff) return "utf16le"; // Node doesn't have utf16be
	} catch {}
	return "utf8";
}

function _claudeGetNewline(filePath) {
	try {
		const sample = _claudeFs.readFileSync(filePath, "utf8").slice(0, 4096);
		return sample.includes("\r\n") ? "CRLF" : "LF";
	} catch {
		return "LF";
	}
}

function _claudeWriteFile(filePath, content, encoding, newline) {
	let output = content;
	// Normalize to LF first, then convert if CRLF needed
	output = output.replace(/\r\n/g, "\n");
	if (newline === "CRLF") {
		output = output.replace(/\n/g, "\r\n");
	}
	_claudeFs.writeFileSync(filePath, output, { encoding: encoding || "utf8" });
}

function _claudeResolvePath(filePath) {
	if (!filePath) return filePath;
	// Handle tilde expansion
	if (filePath.startsWith("~/") || filePath === "~") {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		filePath = _claudePath.join(home, filePath.slice(1));
	}
	// Resolve relative paths
	if (!_claudePath.isAbsolute(filePath)) {
		filePath = _claudePath.resolve(process.cwd(), filePath);
	}
	return _claudePath.normalize(filePath);
}

// Fuzzy string matching (replicates W1A/QI2 behavior)
function _claudeNormalizeQuotes(str) {
	return str
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'") // Smart single quotes
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"'); // Smart double quotes
}

function _claudeFuzzyMatch(content, search) {
	// Direct match first
	if (content.includes(search)) return search;

	// Try with normalized quotes
	const normContent = _claudeNormalizeQuotes(content);
	const normSearch = _claudeNormalizeQuotes(search);
	const idx = normContent.indexOf(normSearch);
	if (idx !== -1) {
		return content.substring(idx, idx + search.length);
	}

	// Try with whitespace normalization (trailing spaces stripped)
	const stripTrailing = (s) =>
		s
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""))
			.join("\n");
	const strippedContent = stripTrailing(content);
	const strippedSearch = stripTrailing(search);
	const idx2 = strippedContent.indexOf(strippedSearch);
	if (idx2 !== -1) {
		// Find the corresponding position in original content
		const lines = strippedContent.slice(0, idx2).split("\n");
		const lineNum = lines.length - 1;
		const colNum = lines[lines.length - 1].length;

		// Map back to original
		const origLines = content.split("\n");
		let pos = 0;
		for (let i = 0; i < lineNum; i++) {
			pos += origLines[i].length + 1;
		}
		pos += colNum;
		return content.substring(pos, pos + search.length);
	}

	return null;
}

// --- Core Edit Logic ---

const _claudeExtendedLinePositions = ["before", "after"];

function _claudeEditHasExtendedFields(A) {
	if (!A) return false;
	const hasOwn = (k) => Object.hasOwn(A, k);

	// Edits array always triggers extended mode
	if (Array.isArray(A.edits) && A.edits.length > 0) return true;

	// Presence of any structured key triggers extended mode
	if (
		hasOwn("line_number") ||
		hasOwn("start_line") ||
		hasOwn("end_line") ||
		hasOwn("diff") ||
		hasOwn("lineNumber") ||
		hasOwn("startLine") ||
		hasOwn("endLine")
	)
		return true;

	// Fallback to value checks
	return (
		_claudeEditSanitizeLine(A.line_number ?? A.lineNumber) !== null ||
		_claudeEditSanitizeLine(A.start_line ?? A.startLine) !== null ||
		_claudeEditSanitizeLine(A.end_line ?? A.endLine) !== null ||
		(typeof A.diff === "string" && A.diff.trim().length > 0)
	);
}

function _claudeEditSanitizeLine(A) {
	if (A === void 0 || A === null || A === "") return null;
	let B = typeof A === "string" ? Number(A) : A;
	if (!Number.isFinite(B)) return null;
	B = Math.floor(B);
	if (B < 1) B = 1;
	return B;
}

function _claudeEditNormalizeEdits(A) {
	const B =
		Array.isArray(A.edits) && A.edits.length > 0
			? A.edits
			: [
					{
						old_string: A.old_string,
						new_string: A.new_string,
						replace_all: A.replace_all,
						line_number: A.line_number,
						line_position: A.line_position,
						start_line: A.start_line,
						end_line: A.end_line,
						diff: A.diff,
					},
				];

	if (!B || B.length === 0) {
		return {
			error: {
				result: false,
				behavior: "ask",
				message: "At least one edit must be specified.",
				errorCode: 13,
			},
		};
	}

	const Q = [];

	const normalizeEntry = (obj) => {
		if (!obj || typeof obj !== "object") return obj;
		if (obj.lineNumber !== undefined && obj.line_number === undefined)
			obj.line_number = obj.lineNumber;
		if (obj.startLine !== undefined && obj.start_line === undefined)
			obj.start_line = obj.startLine;
		if (obj.endLine !== undefined && obj.end_line === undefined)
			obj.end_line = obj.endLine;
		if (obj.linePosition !== undefined && obj.line_position === undefined)
			obj.line_position = obj.linePosition;
		if (obj.replaceAll !== undefined && obj.replace_all === undefined)
			obj.replace_all = obj.replaceAll;
		if (obj.oldString !== undefined && obj.old_string === undefined)
			obj.old_string = obj.oldString;
		if (obj.newString !== undefined && obj.new_string === undefined)
			obj.new_string = obj.newString;
		return obj;
	};

	A = normalizeEntry(A);

	for (let I of B) {
		I = normalizeEntry(I);

		// Diff Mode
		if (typeof I.diff === "string" && I.diff.trim().length > 0) {
			Q.push({ mode: "diff", diff: I.diff });
			continue;
		}

		const rawNewString =
			typeof I.new_string === "string" ? I.new_string : (I.new_string ?? "");
		const Z = typeof I.old_string === "string" ? I.old_string : "";
		const Y = I.replace_all === void 0 ? false : !!I.replace_all;
		let J = _claudeEditSanitizeLine(I.line_number);
		let X = _claudeEditSanitizeLine(I.start_line);
		let W = _claudeEditSanitizeLine(I.end_line);
		const posCandidate =
			typeof I.line_position === "string"
				? I.line_position.toLowerCase()
				: "before";
		const pos = _claudeExtendedLinePositions.includes(posCandidate)
			? posCandidate
			: "before";
		let F = "string";

		if (X !== null || W !== null) {
			if (X === null) X = W;
			if (X === null) {
				return {
					error: {
						result: false,
						behavior: "ask",
						message: "start_line is required when specifying a range.",
						errorCode: 12,
					},
				};
			}
			if (W === null) W = X;
			if (W < X) W = X;
			F = "range";
		} else if (J !== null) {
			F = "line";
		} else if (Z === "" && !Y) {
			// No location, no old_string - treat as append
			F = "line";
			J = Number.MAX_SAFE_INTEGER;
		}

		const normalizedNewString = String(rawNewString).replace(/\r\n/g, "\n");

		Q.push({
			mode: F,
			oldString: Z,
			newString: normalizedNewString,
			replaceAll: Y,
			lineNumber: J,
			linePosition: pos,
			startLine: X,
			endLine: F === "range" ? W : null,
		});
	}

	return { edits: Q };
}

function _claudeEditApplyString(content, edit) {
	// Use fuzzy matching for robustness
	const matched = _claudeFuzzyMatch(content, edit.oldString);

	if (!matched && edit.oldString !== "") {
		return {
			error: {
				result: false,
				behavior: "ask",
				message:
					"String to replace not found in file.\nString: " +
					edit.oldString.slice(0, 100) +
					(edit.oldString.length > 100 ? "..." : ""),
				errorCode: 8,
			},
		};
	}

	if (edit.replaceAll) {
		return {
			content: content.split(matched || edit.oldString).join(edit.newString),
			oldString: matched || edit.oldString,
		};
	} else {
		return {
			content: content.replace(matched || edit.oldString, edit.newString),
			oldString: matched || edit.oldString,
		};
	}
}

function _claudeEditApplyLine(content, edit) {
	const lines = content === "" ? [] : content.split("\n");

	if (edit.lineNumber === null) {
		return {
			error: {
				result: false,
				behavior: "ask",
				message: "line_number is required for line insert.",
				errorCode: 11,
			},
		};
	}

	let insertIdx = Math.min(Math.max(edit.lineNumber - 1, 0), lines.length);
	if (edit.linePosition === "after")
		insertIdx = Math.min(insertIdx + 1, lines.length);

	const newLines = edit.newString === "" ? [""] : edit.newString.split("\n");
	lines.splice(insertIdx, 0, ...newLines);

	return { content: lines.join("\n") };
}

function _claudeEditApplyRange(content, edit) {
	const lines = content === "" ? [] : content.split("\n");

	if (edit.startLine === null) {
		return {
			error: {
				result: false,
				behavior: "ask",
				message: "start_line is required for range replace.",
				errorCode: 12,
			},
		};
	}

	const startIdx = Math.min(Math.max(edit.startLine - 1, 0), lines.length);
	let endLine = edit.endLine ?? edit.startLine;
	if (endLine < edit.startLine) endLine = edit.startLine;
	const endIdx = Math.min(endLine - 1, lines.length - 1);
	const deleteCount = endIdx >= startIdx ? endIdx - startIdx + 1 : 0;

	const newLines = edit.newString === "" ? [] : edit.newString.split("\n");
	lines.splice(startIdx, deleteCount, ...newLines);

	return { content: lines.join("\n") };
}

function _claudeEditApplyDiff(content, edit) {
	const diff = edit.diff;
	const lines = content.split("\n");

	// Track partial application
	const failedHunks = [];
	let appliedHunks = 0;

	// Parse all hunks
	const chunks = diff
		.split(/(^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@.*$)/gm)
		.filter(Boolean);
	const parsedHunks = [];
	let currentHeader = null;

	for (const chunk of chunks) {
		if (chunk.trim().startsWith("@@")) {
			currentHeader = chunk.trim();
			continue;
		}
		if (!currentHeader) continue;

		const headerMatch = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(
			currentHeader,
		);
		if (!headerMatch) {
			currentHeader = null;
			continue;
		}

		const oldStart = parseInt(headerMatch[1], 10);
		const blockLines = chunk.split(/\r?\n/);
		if (blockLines.length > 0 && blockLines[0] === "") blockLines.shift();

		const searchLines = [];
		const replaceLines = [];

		for (const line of blockLines) {
			if (line.startsWith(" ") || line === "") {
				const l = line.startsWith(" ") ? line.slice(1) : line;
				searchLines.push(l);
				replaceLines.push(l);
			} else if (line.startsWith("-")) {
				searchLines.push(line.slice(1));
			} else if (line.startsWith("+")) {
				replaceLines.push(line.slice(1));
			}
		}

		parsedHunks.push({
			header: currentHeader,
			oldStart,
			searchLines,
			replaceLines,
		});
		currentHeader = null;
	}

	if (parsedHunks.length === 0) {
		return {
			error: {
				result: false,
				behavior: "ask",
				message: "Invalid diff format. Expected @@ -old +new @@ header.",
				errorCode: 15,
			},
		};
	}

	// Sort descending by line number to avoid offset issues
	parsedHunks.sort((a, b) => b.oldStart - a.oldStart);

	const modifiedLines = [...lines];

	for (const hunk of parsedHunks) {
		const { oldStart, searchLines, replaceLines, header } = hunk;
		const projectedIndex = Math.max(0, oldStart - 1);

		const isMatch = (startIdx) => {
			if (startIdx < 0 || startIdx + searchLines.length > modifiedLines.length)
				return false;
			for (let k = 0; k < searchLines.length; k++) {
				if (modifiedLines[startIdx + k] !== searchLines[k]) return false;
			}
			return true;
		};

		// Normalize whitespace for comparison (tabs to spaces, collapse multiple spaces)
		const normalizeWs = (s) =>
			s.replace(/\t/g, "    ").replace(/\s+/g, " ").trim();

		const isMatchSloppy = (startIdx) => {
			if (startIdx < 0 || startIdx + searchLines.length > modifiedLines.length)
				return false;
			for (let k = 0; k < searchLines.length; k++) {
				const fileLine = modifiedLines[startIdx + k];
				if (
					fileLine === undefined ||
					normalizeWs(fileLine) !== normalizeWs(searchLines[k])
				)
					return false;
			}
			return true;
		};

		let foundIndex = -1;

		// A: Exact at projected location
		if (isMatch(projectedIndex)) {
			foundIndex = projectedIndex;
		}
		// B: Nearby exact search (+/- 100 lines)
		if (foundIndex === -1) {
			for (let offset = 1; offset < 100; offset++) {
				if (isMatch(projectedIndex - offset)) {
					foundIndex = projectedIndex - offset;
					break;
				}
				if (isMatch(projectedIndex + offset)) {
					foundIndex = projectedIndex + offset;
					break;
				}
			}
		}
		// C: Whitespace-normalized match at projected/nearby (catches tab/space issues early)
		if (foundIndex === -1) {
			if (isMatchSloppy(projectedIndex)) {
				foundIndex = projectedIndex;
			} else {
				for (let offset = 1; offset < 100; offset++) {
					if (isMatchSloppy(projectedIndex - offset)) {
						foundIndex = projectedIndex - offset;
						break;
					}
					if (isMatchSloppy(projectedIndex + offset)) {
						foundIndex = projectedIndex + offset;
						break;
					}
				}
			}
		}
		// D: Global unique exact search
		if (foundIndex === -1) {
			const fileStr = modifiedLines.join("\n");
			const searchStr = searchLines.join("\n");
			const idx = fileStr.indexOf(searchStr);
			const lastIdx = fileStr.lastIndexOf(searchStr);
			if (idx !== -1 && idx === lastIdx) {
				foundIndex = fileStr.slice(0, idx).split("\n").length - 1;
			}
		}
		// E: Global unique whitespace-normalized search
		if (foundIndex === -1) {
			const fileStrNorm = modifiedLines.map(normalizeWs).join("\n");
			const searchStrNorm = searchLines.map(normalizeWs).join("\n");
			const idx = fileStrNorm.indexOf(searchStrNorm);
			const lastIdx = fileStrNorm.lastIndexOf(searchStrNorm);
			if (idx !== -1 && idx === lastIdx) {
				foundIndex = fileStrNorm.slice(0, idx).split("\n").length - 1;
			}
		}

		if (foundIndex === -1) {
			// Track failed hunk but continue with others (partial application)
			failedHunks.push({
				header,
				reason: "Context not found",
				expected:
					searchLines.slice(0, 3).join("\n") +
					(searchLines.length > 3 ? "\n..." : ""),
			});
			continue;
		}

		modifiedLines.splice(foundIndex, searchLines.length, ...replaceLines);
		appliedHunks++;
	}

	// Report results
	if (failedHunks.length > 0 && appliedHunks === 0) {
		// Complete failure - no hunks applied
		return {
			error: {
				result: false,
				behavior: "ask",
				message:
					"Could not apply any hunks.\nFailed hunks:\n" +
					failedHunks.map((h) => `  ${h.header}: ${h.reason}`).join("\n"),
				errorCode: 16,
			},
		};
	}

	if (failedHunks.length > 0) {
		// Partial success - some hunks applied
		return {
			content: modifiedLines.join("\n"),
			warning:
				`Applied ${appliedHunks}/${appliedHunks + failedHunks.length} hunks. Failed:\n` +
				failedHunks.map((h) => `  ${h.header}: ${h.reason}`).join("\n"),
		};
	}

	return { content: modifiedLines.join("\n") };
}

function _claudeApplyExtendedFileEdits(content, edits) {
	let result = content;
	let firstStringEdit = null;
	const warnings = [];
	const appliedEdits = [];

	for (const edit of edits) {
		let outcome;

		if (edit.mode === "diff") outcome = _claudeEditApplyDiff(result, edit);
		else if (edit.mode === "range")
			outcome = _claudeEditApplyRange(result, edit);
		else if (edit.mode === "line") outcome = _claudeEditApplyLine(result, edit);
		else outcome = _claudeEditApplyString(result, edit);

		if (outcome.error) return outcome;

		// Collect warnings from partial application
		if (outcome.warning) {
			warnings.push(outcome.warning);
		}

		// Track applied edits for structured patch generation
		if (edit.mode === "string" && outcome.oldString !== undefined) {
			appliedEdits.push({
				oldString: outcome.oldString,
				newString: edit.newString,
				replaceAll: edit.replaceAll || false,
			});
		}

		if (
			!firstStringEdit &&
			edit.mode === "string" &&
			outcome.oldString !== undefined
		) {
			firstStringEdit = {
				oldString: outcome.oldString,
				newString: edit.newString,
				replaceAll: edit.replaceAll,
			};
		}

		result = outcome.content;
	}

	return {
		content: result,
		firstString: firstStringEdit,
		appliedEdits: appliedEdits.length > 0 ? appliedEdits : undefined,
		warning: warnings.length > 0 ? warnings.join("\n") : undefined,
	};
}

// Simple diff generator for structuredPatch output
// Note: This is a simplified diff - just returns empty array for now to avoid infinite loops
// The structured patch is optional and not critical for edit functionality
function _claudeGenerateSimpleDiff(_oldContent, _newContent, _filePath) {
	// Return empty - the diff generation is complex and not essential
	// The edit still works, just without detailed patch info in the response
	return [];
}
