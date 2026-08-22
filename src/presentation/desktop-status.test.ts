import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopInventoryReport } from "../desktop/contract.js";
import { createDesktopStatusResult } from "../desktop/status.js";
import { renderDesktopStatus } from "./desktop-status.js";

test("human Desktop status names highest-cache selection and unresolved inspection", () => {
	const report: DesktopInventoryReport = {
		schemaVersion: 1,
		platform: "win32",
		applications: [
			{
				locatorId: "desktop:1.2.3",
				layout: "windows-squirrel",
				rootPath: "C:\\synthetic\\app-1.2.3",
				asarPath: "C:\\synthetic\\app-1.2.3\\resources\\app.asar",
				version: "1.2.3",
				packagedAgentSdk: { status: "resolved", version: "0.3.4" },
				declaredCodePin: { status: "unresolved", version: null },
				asarMemberCount: 12,
			},
		],
		selectedApplicationLocatorId: "desktop:1.2.3",
		cacheRoots: [{ locatorId: "desktop-code-cache", path: "C:\\cache" }],
		cachedCode: [
			{
				locatorId: "desktop-code:2.1.9",
				version: "2.1.9",
				cacheRootPath: "C:\\cache",
				binaryPath: "C:\\cache\\2.1.9\\claude.exe",
				platform: "win32-x64",
				binaryFormat: "pe",
				architecture: "x64",
				size: 96,
				sha256: "a".repeat(64),
				signatureInspection: "not-inspected",
				patchReceiptInspection: "not-inspected",
			},
		],
		selectedCodeLocatorId: "desktop-code:2.1.9",
		selectedCodeReason: "highest-cached",
		observedAt: "2026-08-20T12:00:00.000Z",
	};

	assert.deepEqual(renderDesktopStatus(createDesktopStatusResult(report)), [
		"",
		"Claude Desktop Status",
		"",
		"  Platform: win32",
		"  Desktop:  1.2.3 (windows-squirrel)",
		"  Agent SDK: 0.3.4",
		"  Code pin:  unresolved",
		"  App root:  C:\\synthetic\\app-1.2.3",
		"",
		"  Managed Code cache:",
		"    2.1.9 win32-x64 pe x64",
		"      Binary: C:\\cache\\2.1.9\\claude.exe",
		"      Signing: not-inspected; patch receipt: not-inspected",
		"  Selected: 2.1.9 (highest cached; not a declared pin)",
		"",
	]);
});
