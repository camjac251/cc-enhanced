const _claudeExtendedLinePositions = ["before", "after"];
function _claudeEditHasExtendedFields(A) {
	if (!A) return !1;
	if (Array.isArray(A.edits) && A.edits.length > 0) return !0;
	return (
		_claudeEditSanitizeLine(A.line_number) !== null ||
		_claudeEditSanitizeLine(A.start_line) !== null ||
		_claudeEditSanitizeLine(A.end_line) !== null
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
		let B =
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
					},
				];
		if (!B || B.length === 0)
			return {
				error: {
					result: !1,
					behavior: "ask",
					message: "At least one edit must be specified.",
					errorCode: 13,
				},
			};
		let Q = [];
		for (let I of B) {
			let G = typeof I.new_string === "string" ? I.new_string : null;
			if (G === null)
				return {
					error: {
					result: !1,
					behavior: "ask",
					message: "Each edit must include a new_string field.",
					errorCode: 13,
				},
				};
			let Z = typeof I.old_string === "string" ? I.old_string : "";
			let Y = I.replace_all === void 0 ? !1 : !!I.replace_all;
		let J = _claudeEditSanitizeLine(I.line_number);
		let X = _claudeEditSanitizeLine(I.start_line);
		let W = _claudeEditSanitizeLine(I.end_line);
		let posCandidate = 
			typeof I.line_position === "string" ? I.line_position.toLowerCase() : "before";
		let pos = _claudeExtendedLinePositions.includes(posCandidate)
			? posCandidate
			: "before";
		let F = "string";
			if (X !== null || W !== null) {
				if (X === null) X = W;
				if (X === null)
					return {
						error: {
						result: !1,
						behavior: "ask",
						message: "start_line is required when specifying a range of lines.",
						errorCode: 12,
					},
					};
				if (W === null) W = X;
				if (W < X) W = X;
				F = "range";
			} else if (J !== null) F = "line";
			Q.push({
				mode: F,
				oldString: Z,
				newString: G.replaceAll(`\r\n`, `\n`),
				replaceAll: Y,
			lineNumber: J,
		linePosition: pos,
			startLine: X,
			endLine: F === "range" ? W : null,
			});
		}
		return { edits: Q };
	}
    function _claudeEditApplyString(A, B) {
        let Q = Ms(A, B.oldString) || B.oldString;
		if (Q && Q !== "" && !A.includes(Q))
			return {
				error: {
					result: !1,
					behavior: "ask",
					message: `String to replace not found in file.\nString: ${B.oldString}`,
					errorCode: 8,
				},
			};
		if (Q === "" && B.oldString !== "" && A !== "") Q = B.oldString;
		if (Q !== "") {
			let I = A.split(Q).length - 1;
			if (I > 1 && !B.replaceAll)
				return {
					error: {
					result: !1,
					behavior: "ask",
					message: `Found ${I} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${B.oldString}`,
					errorCode: 9,
				},
				};
			if (I === 0)
				return {
					error: {
					result: !1,
					behavior: "ask",
					message: `String to replace not found in file.\nString: ${B.oldString}`,
					errorCode: 8,
				},
				};
        }
        let Z = gNQ(A, Q, B.newString, B.replaceAll);
		if (Z === A && Q !== "")
			return {
				error: {
					result: !1,
					behavior: "ask",
					message: `String to replace not found in file.\nString: ${B.oldString}`,
					errorCode: 8,
				},
			};
		return { content: Z, oldString: Q };
	}
	function _claudeEditApplyLine(A, B) {
		let Q = A === "" ? [] : A.split("\n");
		let I = Q.length;
		if (B.lineNumber === null)
			return {
				error: {
					result: !1,
					behavior: "ask",
					message: "line_number is required when inserting text by line.",
					errorCode: 11,
				},
			};
		let Z = Math.min(Math.max(B.lineNumber - 1, 0), Q.length);
		if (B.linePosition === "after") Z = Math.min(Z + 1, Q.length);
		let Y = B.newString === "" ? [""] : B.newString.split("\n");
		Q.splice(Z, 0, ...Y);
		return { content: Q.join("\n") };
	}
	function _claudeEditApplyRange(A, B) {
		let Q = A === "" ? [] : A.split("\n");
		let I = Q.length;
		if (B.startLine === null)
			return {
				error: {
					result: !1,
					behavior: "ask",
					message: "start_line is required when replacing a range of lines.",
					errorCode: 12,
				},
			};
		let Z = Math.min(Math.max(B.startLine - 1, 0), Q.length);
		let Y = B.endLine ?? B.startLine;
		if (Y < B.startLine) Y = B.startLine;
		let J = Math.min(Y - 1, Q.length - 1);
		let X = J >= Z ? J - Z + 1 : 0;
		let W = B.newString === "" ? [""] : B.newString.split("\n");
		Q.splice(Z, X, ...W);
		return { content: Q.join("\n") };
	}
	function _claudeApplyExtendedFileEdits(A, B) {
		let Q = A;
		let I = null;
		for (let G of B) {
			let Z;
			if (G.mode === "range") Z = _claudeEditApplyRange(Q, G);
			else if (G.mode === "line") Z = _claudeEditApplyLine(Q, G);
			else Z = _claudeEditApplyString(Q, G);
			if (Z.error) return Z;
			if (!I && G.mode === "string" && Z.oldString !== void 0)
				I = { oldString: Z.oldString, newString: G.newString, replaceAll: G.replaceAll };
			Q = Z.content;
		}
		return { content: Q, firstString: I };
	}
	const _claudeOriginalEditValidate = __CLAUDE_EDIT_TOOL__.validateInput;
	__CLAUDE_EDIT_TOOL__.validateInput = async function (A, B) {
		if (!_claudeEditHasExtendedFields(A)) {
			if (
				typeof A.old_string !== "string" ||
				A.old_string === undefined ||
				A.old_string === null
			) {
				return {
					result: !1,
					behavior: "ask",
					message:
						"Provide old_string for simple replacements or include line_number/line_position, start_line/end_line, or an edits array to describe structured inserts.",
					errorCode: 14,
				};
			}
			return _claudeOriginalEditValidate.call(this, A, B);
		}
		let Q = _claudeEditNormalizeEdits(A);
		if (Q.error) return Q.error;
		let I = zaA(A.file_path) ? A.file_path : Ws6(Z0(), A.file_path);
		let G = await B.getAppState();
		if (rC(I, G.toolPermissionContext, "edit", "deny") !== null)
			return {
				result: !1,
				behavior: "ask",
				message: "File is in a directory that is denied by your permission settings.",
				errorCode: 2,
			};
		let Z = NA();
		let Y = Z.existsSync(I);
		if (Y && I.endsWith(".ipynb"))
			return {
				result: !1,
				behavior: "ask",
				message: `File is a Jupyter Notebook. Use the ${dh} to edit this file.`, 
				errorCode: 5,
			};
		if (Y && Q.edits.some((W) => W.mode === "string" && W.oldString === ""))
			return {
				result: !1,
				behavior: "ask",
				message: "Cannot create new file - file already exists.",
				errorCode: 3,
			};
		if (!Y) {
			let W = Q.edits.some((F) => F.mode === "string" && F.oldString !== "");
			if (W) {
				let H = UaA(I);
				let w = "File does not exist.";
				let L = Z0();
				let K = nB();
				if (L !== K) w += ` Current working directory: ${L}`;
				if (H) w += ` Did you mean ${H}?`;
				return { result: !1, behavior: "ask", message: w, errorCode: 4 };
			}
		}
		let V = Y ? Uw(I) : "";
		let J = _claudeApplyExtendedFileEdits(V, Q.edits);
		if (J.error) return J.error;
		return { result: !0 };
	};
	const _claudeOriginalEditCall = __CLAUDE_EDIT_TOOL__.call;
	__CLAUDE_EDIT_TOOL__.call = async function (A, B, Q, I) {
		if (!_claudeEditHasExtendedFields(A)) return _claudeOriginalEditCall.call(this, A, B, Q, I);
		let Z = _claudeEditNormalizeEdits(A);
		if (Z.error) throw Error(Z.error.message);
		let Y = NA();
		let J = M9(A.file_path);
		await bx.beforeFileEdited(J);
		let X = Y.existsSync(J);
		let W = X ? Uw(J) : "";
		if (zG()) await v4A(B.updateFileHistoryState, J, I.uuid);
		let L = _claudeApplyExtendedFileEdits(W, Z.edits);
		if (L.error) throw Error(L.error.message);
		let K = EqQ({ filePath: J, oldContent: W, newContent: L.content });
		let E = Xs6(J);
		Y.mkdirSync(E);
		let H = X ? Rs(J) : "LF";
		let w = X ? PK(J) : "utf8";
		X6A(J, L.content, w, H);
		let F = jm();
		if (F)
			F.changeFile(J, L.content).catch((V) => {
				BA(V, P7);
			}),
			F.saveFile(J).catch((V) => {
				BA(V, P7);
			});
		B.readFileState.set(J, {
			content: L.content,
			timestamp: BV(J),
			offset: void 0,
			limit: void 0,
		});
		if (J.endsWith(`${Fs6}CLAUDE.md`)) GA("tengu_write_claudemd", {});
		iDA(K);
		mj({ operation: "edit", tool: "FileEditTool", filePath: J });
		return {
			data: {
				filePath: A.file_path,
				oldString: (L.firstString && L.firstString.oldString) || "",
				newString: (L.firstString && L.firstString.newString) || "",
				originalFile: W,
				structuredPatch: K,
				userModified: B.userModified ?? !1,
				replaceAll: (L.firstString && L.firstString.replaceAll) || !1,
				appliedEditsCount: Z.edits.length,
			},
		};
	};
	const _claudeOriginalEditInputsEquivalent = __CLAUDE_EDIT_TOOL__.inputsEquivalent;
	__CLAUDE_EDIT_TOOL__.inputsEquivalent = function (A, B) {
		if (!_claudeEditHasExtendedFields(A) && !_claudeEditHasExtendedFields(B))
			return _claudeOriginalEditInputsEquivalent.call(this, A, B);
		let Q = _claudeEditNormalizeEdits(A);
		let I = _claudeEditNormalizeEdits(B);
		if (Q.error || I.error) return !1;
		if (A.file_path !== B.file_path) return !1;
		if (Q.edits.length !== I.edits.length) return !1;
		for (let G = 0; G < Q.edits.length; G++) {
			let Z = Q.edits[G];
			let Y = I.edits[G];
			if (
				Z.mode !== Y.mode ||
				Z.oldString !== Y.oldString ||
				Z.newString !== Y.newString ||
				Z.replaceAll !== Y.replaceAll ||
				Z.lineNumber !== Y.lineNumber ||
				Z.linePosition !== Y.linePosition ||
				Z.startLine !== Y.startLine ||
				Z.endLine !== Y.endLine
			)
				return !1;
		}
		return !0;
	};
	const _claudeOriginalEditReject = __CLAUDE_EDIT_TOOL__.renderToolUseRejectedMessage;
	__CLAUDE_EDIT_TOOL__.renderToolUseRejectedMessage = function (A, B) {
		if (!_claudeEditHasExtendedFields(A)) return _claudeOriginalEditReject.call(this, A, B);
		try {
			let Q = _claudeEditNormalizeEdits(A);
			if (Q.error) return _claudeOriginalEditReject.call(this, A, B);
			let I = M9(A.file_path);
			let G = NA();
			let Z = G.existsSync(I) ? Uw(I) : "";
			let Y = _claudeApplyExtendedFileEdits(Z, Q.edits);
			if (Y.error) return _claudeOriginalEditReject.call(this, A, B);
			let J = EqQ({ filePath: I, oldContent: Z, newContent: Y.content });
			return $W.createElement(khQ, {
				file_path: A.file_path,
				operation: "update",
				patch: J,
				style: B.style,
				verbose: B.verbose,
			});
		} catch {
			return _claudeOriginalEditReject.call(this, A, B);
		}
	};
	const _claudeOriginalEditMapResult =
		__CLAUDE_EDIT_TOOL__.mapToolResultToToolResultBlockParam;
	__CLAUDE_EDIT_TOOL__.mapToolResultToToolResultBlockParam = function (A, B) {
		if (A && typeof A.appliedEditsCount === "number" && A.appliedEditsCount > 0) {
			let Q = A.appliedEditsCount === 1 ? "1 edit" : `${A.appliedEditsCount} edits`;
			return {
				tool_use_id: B,
				type: "tool_result",
				content: `The file ${A.filePath} has been updated with ${Q}.`,
			};
		}
		return _claudeOriginalEditMapResult.call(this, A, B);
	};
