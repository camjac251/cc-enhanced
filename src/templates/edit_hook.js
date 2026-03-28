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
	// Batch edits array triggers extended mode
	return Array.isArray(A.edits) && A.edits.length > 0;
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

function _claudeEditBatchError(message, errorCode) {
	return {
		error: {
			result: false,
			behavior: "ask",
			message,
			errorCode,
		},
	};
}

function _claudeEditNormalizeEdits(A) {
	const normalizeEntry = (obj) => {
		if (!obj || typeof obj !== "object") return obj;
		if (obj.replaceAll !== undefined && obj.replace_all === undefined)
			obj.replace_all = obj.replaceAll;
		if (obj.oldString !== undefined && obj.old_string === undefined)
			obj.old_string = obj.oldString;
		if (obj.newString !== undefined && obj.new_string === undefined)
			obj.new_string = obj.newString;
		return obj;
	};

	A = normalizeEntry(A);

	const B =
		Array.isArray(A.edits) && A.edits.length > 0
			? A.edits
			: [
					{
						old_string: A.old_string,
						new_string: A.new_string,
						replace_all: A.replace_all,
					},
				];

	if (!B || B.length === 0) {
		return _claudeEditBatchError("At least one edit must be specified.", 13);
	}

	const Q = [];

	for (let I of B) {
		I = normalizeEntry(I);

		const hasOldStringInput =
			I.old_string !== undefined && I.old_string !== null;
		const hasNewStringInput =
			I.new_string !== undefined && I.new_string !== null;
		const Z = typeof I.old_string === "string" ? I.old_string : "";
		const rawNewString =
			typeof I.new_string === "string" ? I.new_string : (I.new_string ?? "");
		const Y = _claudeEditParseBoolean(I.replace_all, false);

		if (!hasOldStringInput && !hasNewStringInput) {
			return _claudeEditBatchError(
				"Invalid edit: provide old_string and new_string.",
				25,
			);
		}
		if (Z === "" && rawNewString === "") {
			return _claudeEditBatchError(
				"Invalid edit: old_string and new_string cannot both be empty.",
				26,
			);
		}
		if (Z === "" && Y) {
			return _claudeEditBatchError(
				"Invalid edit: old_string cannot be empty when replace_all is true.",
				19,
			);
		}

		Q.push({
			mode: "string",
			oldString: Z,
			newString: String(rawNewString).replace(/\r\n/g, "\n"),
			replaceAll: Y,
			isAppend: Z === "",
		});
	}

	return { edits: Q };
}

function _claudeEditApplyString(content, edit) {
	// Append mode: empty old_string adds to end of file
	if (edit.isAppend) {
		const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		return { content: content + sep + edit.newString };
	}

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

function _claudeApplyExtendedFileEdits(content, edits) {
	let result = content;
	let firstStringEdit = null;
	const warnings = [];
	const appliedEdits = [];

	// All edits are string replace (content-addressed), applied in order
	for (const edit of edits) {
		const outcome = _claudeEditApplyString(result, edit);
		if (outcome.error) return outcome;

		if (outcome.warning) warnings.push(outcome.warning);

		if (outcome.oldString !== undefined) {
			const matchCount = outcome.matchCount || 1;
			if (edit.replaceAll && matchCount > 1) {
				for (let i = 0; i < matchCount; i++) {
					appliedEdits.push({
						oldString: outcome.oldString,
						newString: edit.newString,
						replaceAll: false,
					});
				}
			} else {
				appliedEdits.push({
					oldString: outcome.oldString,
					newString: edit.newString,
					replaceAll: edit.replaceAll || false,
				});
			}
		}

		if (!firstStringEdit && outcome.oldString !== undefined) {
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
