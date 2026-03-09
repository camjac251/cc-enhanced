// Self-contained edit helpers - no dependency on minified variable names.
// Keep these as ESM imports so the injected block works in module scope.
import * as _claudeFs from "node:fs";
import * as _claudePath from "node:path";

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

function _claudeEditUnwrapQuotedScalar(A) {
	if (typeof A !== "string") return A;
	let B = A.trim();
	for (let i = 0; i < 2; i++) {
		if (B.length < 2) break;
		const first = B[0];
		const last = B[B.length - 1];
		const isQuoted =
			(first === '"' && last === '"') || (first === "'" && last === "'");
		if (!isQuoted) break;
		B = B.slice(1, -1).trim();
	}
	return B;
}

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
		hasOwn("pattern") ||
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
		(typeof A.diff === "string" && A.diff.trim().length > 0) ||
		(typeof A.pattern === "string" && A.pattern.length > 0)
	);
}

function _claudeEditSanitizeLine(A) {
	if (A === void 0 || A === null || A === "") return null;
	const B = _claudeEditUnwrapQuotedScalar(A);
	const C = typeof B === "string" ? Number(B) : B;
	if (!Number.isFinite(C)) return null;
	if (!Number.isInteger(C)) return null;
	if (C < 1) return null;
	return C;
}

function _claudeEditParseBoolean(A, fallback = false) {
	if (A === void 0 || A === null || A === "") return fallback;
	if (typeof A === "boolean") return A;
	if (typeof A === "number") return A !== 0;
	if (typeof A === "string") {
		const B = String(_claudeEditUnwrapQuotedScalar(A)).trim().toLowerCase();
		if (B === "true" || B === "1" || B === "yes" || B === "on") return true;
		if (B === "false" || B === "0" || B === "no" || B === "off" || B === "")
			return false;
	}
	return !!A;
}

function _claudeParseDiffHunks(diffText) {
	const chunks = diffText
		.split(/(^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@.*$)/gm)
		.filter(Boolean);
	const hunks = [];
	let currentHeader = null;

	for (const chunk of chunks) {
		if (chunk.trim().startsWith("@@")) {
			currentHeader = chunk.trim();
			continue;
		}
		if (!currentHeader) continue;

		const blockLines = chunk.split(/\r?\n/);
		if (blockLines.length > 0 && blockLines[0] === "") blockLines.shift();
		while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "")
			blockLines.pop();

		const searchLines = [];
		const replaceLines = [];

		for (const line of blockLines) {
			if (line.startsWith(" ")) {
				searchLines.push(line.slice(1));
				replaceLines.push(line.slice(1));
			} else if (line.startsWith("-")) {
				searchLines.push(line.slice(1));
			} else if (line.startsWith("+")) {
				replaceLines.push(line.slice(1));
			} else if (line === "") {
				searchLines.push("");
				replaceLines.push("");
			}
		}

		if (searchLines.length > 0 || replaceLines.length > 0) {
			hunks.push({
				searchText: searchLines.join("\n"),
				replaceText: replaceLines.join("\n"),
			});
		}
		currentHeader = null;
	}

	return hunks;
}

function _claudeEditNormalizeEdits(A) {
	const B =
		Array.isArray(A.edits) && A.edits.length > 0
			? A.edits
			: [
					{
						old_string: A.old_string ?? A.oldString,
						new_string: A.new_string ?? A.newString,
						replace_all: A.replace_all ?? A.replaceAll,
						line_number: A.line_number ?? A.lineNumber,
						line_position: A.line_position ?? A.linePosition,
						start_line: A.start_line ?? A.startLine,
						end_line: A.end_line ?? A.endLine,
						diff: A.diff,
						pattern: A.pattern,
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

		let J = _claudeEditSanitizeLine(I.line_number);
		let X = _claudeEditSanitizeLine(I.start_line);
		let W = _claudeEditSanitizeLine(I.end_line);
		const hasDiffMode = typeof I.diff === "string" && I.diff.trim().length > 0;
		const hasRegexMode =
			typeof I.pattern === "string" && String(I.pattern).length > 0;
		const hasDiffKey = I.diff !== undefined;
		const hasPatternKey = I.pattern !== undefined;
		const hasLineKey = I.line_number !== undefined;
		const hasStartKey = I.start_line !== undefined;
		const hasEndKey = I.end_line !== undefined;
		const hasRangeKey = hasStartKey || hasEndKey;
		const hasExplicitModeKey =
			hasDiffKey || hasPatternKey || hasLineKey || hasRangeKey;
		const hasOldStringKey = I.old_string !== undefined;
		const hasRangeMode = X !== null || W !== null;
		const hasLineMode = J !== null;
		const explicitModeCount =
			(hasDiffMode ? 1 : 0) +
			(hasRegexMode ? 1 : 0) +
			(hasRangeMode ? 1 : 0) +
			(hasLineMode ? 1 : 0);

		if (hasPatternKey && !hasRegexMode) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message: "Invalid regex mode: pattern must be a non-empty string.",
					errorCode: 20,
				},
			};
		}

		if (hasDiffKey && !hasDiffMode) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message: "Invalid diff mode: diff must be a non-empty string.",
					errorCode: 21,
				},
			};
		}

		if (hasLineKey && !hasLineMode) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message: "Invalid line mode: line_number must be a positive integer.",
					errorCode: 22,
				},
			};
		}

		if (hasStartKey && X === null) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						"Invalid range mode: start_line/end_line must be positive integers.",
					errorCode: 23,
				},
			};
		}

		if (hasEndKey && W === null) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						"Invalid range mode: start_line/end_line must be positive integers.",
					errorCode: 23,
				},
			};
		}

		if (!hasStartKey && hasEndKey) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						"Invalid range mode: start_line is required when end_line is provided.",
					errorCode: 24,
				},
			};
		}

		if (hasRangeKey && !hasRangeMode) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						"Invalid range mode: start_line/end_line must be positive integers.",
					errorCode: 23,
				},
			};
		}

		if (explicitModeCount > 1) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						"Each edit must specify exactly one explicit mode: diff, regex (pattern), line_number, or range (start_line/end_line).",
					errorCode: 18,
				},
			};
		}
		if (hasOldStringKey && hasExplicitModeKey) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						"Invalid edit: old_string cannot be combined with explicit modes (diff, pattern, line_number, start_line/end_line).",
					errorCode: 28,
				},
			};
		}

		// Diff Mode - convert hunks to string replaces
		if (hasDiffMode) {
			const hunks = _claudeParseDiffHunks(I.diff);
			if (hunks.length === 0) {
				return {
					error: {
						result: false,
						behavior: "ask",
						message:
							"Invalid diff format. Expected @@ -old +new @@ header with context/change lines.",
						errorCode: 15,
					},
				};
			}
			for (const hunk of hunks) {
				if (hunk.searchText === "") {
					return {
						error: {
							result: false,
							behavior: "ask",
							message:
								"Unsupported diff hunk: pure insertion hunks must include at least one context or removal line.",
							errorCode: 16,
						},
					};
				}
				Q.push({
					mode: "string",
					oldString: hunk.searchText,
					newString: hunk.replaceText,
					replaceAll: false,
				});
			}
			continue;
		}

		// Regex Mode
		if (hasRegexMode) {
			const newStr = typeof I.new_string === "string" ? I.new_string : "";
			Q.push({
				mode: "regex",
				pattern: I.pattern,
				newString: newStr,
				replaceAll: _claudeEditParseBoolean(I.replace_all, false),
			});
			continue;
		}

		const rawNewString =
			typeof I.new_string === "string" ? I.new_string : (I.new_string ?? "");
		const hasOldStringInput =
			I.old_string !== undefined && I.old_string !== null;
		const hasNewStringInput =
			I.new_string !== undefined && I.new_string !== null;
		const Z = typeof I.old_string === "string" ? I.old_string : "";
		const Y = _claudeEditParseBoolean(I.replace_all, false);
		const posCandidate =
			typeof I.line_position === "string"
				? String(_claudeEditUnwrapQuotedScalar(I.line_position)).toLowerCase()
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
		} else if (!hasOldStringInput && !hasNewStringInput) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						"Invalid edit: provide either explicit mode fields (diff/pattern/line_number/start_line) or string mode fields (old_string/new_string).",
					errorCode: 25,
				},
			};
		} else if (Z === "" && rawNewString === "") {
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						"Invalid edit: old_string and new_string cannot both be empty. Use range/line mode for positional edits.",
					errorCode: 26,
				},
			};
		} else if (Z === "" && !Y) {
			// No location, no old_string - treat as append
			F = "line";
			J = Number.MAX_SAFE_INTEGER;
		}

		const normalizedNewString = String(rawNewString).replace(/\r\n/g, "\n");

		if (F === "string" && Z === "" && Y) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						"Invalid edit: old_string cannot be empty when replace_all is true. Use range mode, line insertion, or set replace_all to false.",
					errorCode: 19,
				},
			};
		}

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

	const searchStr = matched || edit.oldString;

	// Count occurrences to check uniqueness
	if (!edit.replaceAll && searchStr !== "") {
		let count = 0;
		let pos = 0;
		const positions = [];
		pos = content.indexOf(searchStr, pos);
		while (pos !== -1) {
			count++;
			// Track line numbers for context
			const lineNum = content.slice(0, pos).split("\n").length;
			positions.push(lineNum);
			pos += searchStr.length;
			if (count > 10) break; // Don't scan entire huge files
			pos = content.indexOf(searchStr, pos);
		}

		if (count > 1) {
			const lineInfo =
				positions.slice(0, 5).join(", ") + (positions.length > 5 ? "..." : "");
			return {
				error: {
					result: false,
					behavior: "ask",
					message:
						`old_string matches ${count}${count > 10 ? "+" : ""} locations (lines: ${lineInfo}). ` +
						"Add more context to make it unique, or use replace_all:true to replace all.\n" +
						"String: " +
						edit.oldString.slice(0, 80) +
						(edit.oldString.length > 80 ? "..." : ""),
					errorCode: 9,
				},
			};
		}
	}

	if (edit.replaceAll) {
		const parts = content.split(searchStr);
		return {
			content: parts.join(edit.newString),
			oldString: searchStr,
			matchCount: parts.length - 1,
		};
	} else {
		return {
			content: content.replace(searchStr, edit.newString),
			oldString: searchStr,
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
	const lineCount = lines.length;

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

	if (lineCount === 0 && edit.startLine > 1) {
		return {
			error: {
				result: false,
				behavior: "ask",
				message:
					"Invalid range: start_line exceeds file length. Use start_line:1 for empty files or line mode to append.",
				errorCode: 27,
			},
		};
	}

	if (lineCount > 0 && edit.startLine > lineCount) {
		return {
			error: {
				result: false,
				behavior: "ask",
				message:
					"Invalid range: start_line exceeds file length. Use line mode for append-after-end behavior.",
				errorCode: 27,
			},
		};
	}

	const startIdx = lineCount === 0 ? 0 : edit.startLine - 1;
	let endLine = edit.endLine ?? edit.startLine;
	if (endLine < edit.startLine) endLine = edit.startLine;
	const endIdx =
		lineCount === 0
			? -1
			: Math.min(Math.max(endLine - 1, startIdx), lineCount - 1);
	const deleteCount = lineCount === 0 ? 0 : endIdx - startIdx + 1;

	const newLines = edit.newString === "" ? [] : edit.newString.split("\n");
	lines.splice(startIdx, deleteCount, ...newLines);

	return { content: lines.join("\n") };
}

function _claudeEditApplyRegex(content, edit) {
	try {
		// Parse regex - support /pattern/flags format or plain pattern
		let pattern = edit.pattern;
		let flags = edit.replaceAll ? "g" : "";

		// Check if pattern is in /pattern/flags format
		const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
		if (regexMatch) {
			pattern = regexMatch[1];
			flags = regexMatch[2] || "";
		}

		if (edit.replaceAll) {
			// Ensure global replacement when replace_all is explicitly true.
			if (!flags.includes("g")) flags += "g";
		} else {
			// Keep regex mode aligned with replace_all semantics even if user passed /.../g.
			flags = flags.replace(/g/g, "");
		}

		const regex = new RegExp(pattern, flags);
		const matches = content.match(regex);

		if (!matches || matches.length === 0) {
			return {
				error: {
					result: false,
					behavior: "ask",
					message: `Regex pattern not found in file.\nPattern: ${edit.pattern}`,
					errorCode: 17,
				},
			};
		}

		const newContent = content.replace(regex, edit.newString);
		const matchCount = matches.length;

		// Get the actual interpolated replacement for first match (for diff display)
		const firstMatchRegex = new RegExp(pattern, flags.replace("g", ""));
		const actualNewString = matches[0].replace(firstMatchRegex, edit.newString);

		return {
			content: newContent,
			matchCount,
			// For display purposes, show first match as "old"
			oldString: matches[0],
			// Actual interpolated replacement (with $1, $2 etc resolved)
			newString: actualNewString,
		};
	} catch (e) {
		return {
			error: {
				result: false,
				behavior: "ask",
				message: `Invalid regex pattern: ${e.message}`,
				errorCode: 18,
			},
		};
	}
}

function _claudeApplyExtendedFileEdits(content, edits) {
	let result = content;
	let firstStringEdit = null;
	const warnings = [];
	const appliedEdits = [];

	// Apply in user-provided order to preserve deterministic intent.
	for (const edit of edits) {
		let outcome;

		if (edit.mode === "regex") outcome = _claudeEditApplyRegex(result, edit);
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
		if (
			(edit.mode === "string" || edit.mode === "regex") &&
			outcome.oldString !== undefined
		) {
			// Use outcome.newString for regex (interpolated $1,$2) or edit.newString for string mode
			const displayNewString =
				outcome.newString !== undefined ? outcome.newString : edit.newString;
			// For replaceAll with multiple matches, expand into individual edits for better patch generation
			const matchCount = outcome.matchCount || 1;
			if (edit.replaceAll && matchCount > 1) {
				for (let i = 0; i < matchCount; i++) {
					appliedEdits.push({
						oldString: outcome.oldString,
						newString: displayNewString,
						replaceAll: false, // Individual replacements
					});
				}
			} else {
				appliedEdits.push({
					oldString: outcome.oldString,
					newString: displayNewString,
					replaceAll: edit.replaceAll || false,
				});
			}
		}

		if (
			!firstStringEdit &&
			(edit.mode === "string" || edit.mode === "regex") &&
			outcome.oldString !== undefined
		) {
			const displayNewString =
				outcome.newString !== undefined ? outcome.newString : edit.newString;
			firstStringEdit = {
				oldString: outcome.oldString,
				newString: displayNewString,
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
