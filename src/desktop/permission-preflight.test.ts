import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createSyntheticDesktopPermissionInputs } from "../../scripts/test-fixtures/desktop.js";
import {
	createDesktopPermissionPreflight,
	readDesktopPermissionPreflightInputs,
	validateDesktopPermissionPreflightEvidence,
} from "./permission-preflight.js";

test("Desktop permission preflight binds exact stock evidence and reports actionable blockers", () => {
	const inputs = createSyntheticDesktopPermissionInputs();
	const evidence = createDesktopPermissionPreflight(inputs);

	assert.equal(evidence.schemaVersion, 1);
	for (const digest of Object.values(evidence.bindings)) {
		assert.match(digest, /^[a-f0-9]{64}$/);
	}
	assert.deepEqual(evidence.target, {
		desktopLocatorId: "desktop:1.2.3",
		desktopVersion: "1.2.3",
		packagedAgentSdkVersion: "0.3.4",
		codeLocatorId: "desktop-code:2.1.9",
		codeVersion: "2.1.9",
		platform: "win32",
		nativePlatform: "win32-x64",
		binaryFormat: "pe",
		architecture: "x64",
		size: 96,
		sha256: "a".repeat(64),
		inventorySelectionReason: "highest-cached",
	});
	assert.deepEqual(
		evidence.gates.map((gate) => [gate.id, gate.status, gate.responsibility]),
		[
			["receipt-contracts", "pass", "repository"],
			["sdk-inventory-binding", "pass", "repository"],
			["plan-sdk-binding", "pass", "repository"],
			["artifact-inventory-binding", "pass", "repository"],
			["official-stock-identity", "pass", "repository"],
			["platform-signature-presence", "pass", "repository"],
			["platform-signature-validity", "blocked", "matching-host"],
			["owner-target-selection", "blocked", "owner"],
			["stock-baseline-consent", "blocked", "owner"],
			["desktop-profile-boundary", "pass", "repository"],
			["isolated-synthetic-workspace", "blocked", "operator"],
			["cleanup-preparation", "blocked", "operator"],
		],
	);
	assert.deepEqual(
		evidence.blockers.map((blocker) => [blocker.code, blocker.responsibility]),
		[
			["matching-host-signature-validity-required", "matching-host"],
			["owner-target-selection-required", "owner"],
			["owner-stock-baseline-consent-required", "owner"],
			["isolated-synthetic-workspace-required", "operator"],
			["cleanup-preparation-required", "operator"],
		],
	);
	assert.equal(evidence.readyForStockBaseline, false);
	assert.deepEqual(evidence.boundaries, {
		readOnly: true,
		desktopLaunch: "not-authorized",
		managedArtifactMutation: "not-authorized",
		patchedCandidate: "closed",
		profileSelection: "blocked",
		remoteControl: "closed",
		selfHosted: "closed",
		execution: "not-run",
	});
	validateDesktopPermissionPreflightEvidence(evidence, inputs);
	assert.doesNotMatch(
		JSON.stringify(evidence),
		/\/home\/|[A-Z]:\\\\|processId|sessionId|credential|fixtureContents/,
	);
});

test("Desktop permission preflight rejects drift, weak stock proof, and profile promotion", () => {
	const inputs = createSyntheticDesktopPermissionInputs();

	const replacedArtifact = structuredClone(inputs);
	replacedArtifact.artifact.sha256 = "f".repeat(64);
	replacedArtifact.artifact.provenance.manifestSha256 = "f".repeat(64);
	assert.throws(
		() => createDesktopPermissionPreflight(replacedArtifact),
		/artifact.*inventory|identity|binding/i,
	);

	const markerOnly = structuredClone(inputs);
	markerOnly.artifact.provenance = {
		status: "not-run",
		manifestUrl: null,
		manifestSha256: null,
		manifestSize: null,
		manifestSignature: "not-run",
	};
	assert.throws(
		() => createDesktopPermissionPreflight(markerOnly),
		/official|provenance|stock/i,
	);

	const unknownReceipt = structuredClone(inputs);
	unknownReceipt.artifact.patchReceipt = { status: "not-run", tags: [] };
	assert.throws(
		() => createDesktopPermissionPreflight(unknownReceipt),
		/patch receipt|stock/i,
	);

	const promotedProfile = structuredClone(inputs) as unknown as {
		profileSupport: { selectable: boolean };
	};
	promotedProfile.profileSupport.selectable = true;
	assert.throws(
		() => createDesktopPermissionPreflight(promotedProfile as never),
		/profile|support|evidence/i,
	);
});

test("Desktop permission preflight reads only bounded stable regular files", async () => {
	const temporaryRoot = await mkdtemp(
		path.join(tmpdir(), "cc-enhanced-desktop-preflight-"),
	);
	try {
		const inputs = createSyntheticDesktopPermissionInputs();
		const paths = {
			inventoryPath: path.join(temporaryRoot, "inventory-source.json"),
			artifactPath: path.join(temporaryRoot, "artifact.json"),
			sdkContractPath: path.join(temporaryRoot, "sdk-contract.json"),
			probePlanPath: path.join(temporaryRoot, "probe-plan.json"),
			profileSupportPath: path.join(temporaryRoot, "profile-support.json"),
		};
		await writeFile(paths.inventoryPath, JSON.stringify(inputs.inventory));
		await writeFile(paths.artifactPath, JSON.stringify(inputs.artifact));
		await writeFile(paths.sdkContractPath, JSON.stringify(inputs.sdkContract));
		await writeFile(paths.probePlanPath, JSON.stringify(inputs.probePlan));
		await writeFile(
			paths.profileSupportPath,
			JSON.stringify(inputs.profileSupport),
		);

		const linkedInventory = path.join(temporaryRoot, "inventory.json");
		await symlink(paths.inventoryPath, linkedInventory);
		await assert.rejects(
			readDesktopPermissionPreflightInputs({
				...paths,
				inventoryPath: linkedInventory,
			}),
			/regular file|symbolic link/i,
		);

		const duplicateInventory = path.join(
			temporaryRoot,
			"duplicate-inventory.json",
		);
		await writeFile(
			duplicateInventory,
			JSON.stringify(inputs.inventory).replace("{", '{"schemaVersion":1,'),
		);
		await assert.rejects(
			readDesktopPermissionPreflightInputs({
				...paths,
				inventoryPath: duplicateInventory,
			}),
			/duplicate key schemaVersion/i,
		);

		const oversizedProfile = path.join(temporaryRoot, "oversized-profile.json");
		await writeFile(oversizedProfile, Buffer.alloc(1024 * 1024 + 1, 32));
		await assert.rejects(
			readDesktopPermissionPreflightInputs({
				...paths,
				profileSupportPath: oversizedProfile,
			}),
			/size exceeds limit/i,
		);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});
