import * as fs from "node:fs";
import { createRequire } from "node:module";
import type LIEF from "node-lief";

const require = createRequire(import.meta.url);

type NodeLiefModule = typeof LIEF;

export interface NativeBunSectionLayout {
	format: "MachO" | "PE";
	sectionName: "__bun" | ".bun";
	segmentName?: "__BUN";
	fileOffset: number;
	fileSize: number;
	virtualAddress: bigint;
	virtualSize: bigint;
	segmentFileOffset?: number;
	segmentFileSize?: number;
	segmentVirtualAddress?: bigint;
	segmentVirtualSize?: bigint;
	hasCodeSignature: boolean | null;
}

function loadNodeLief(): NodeLiefModule {
	const lief = require("node-lief") as NodeLiefModule;
	lief.logging.disable();
	return lief;
}

function safeBigIntToNumber(label: string, value: bigint): number {
	const numberValue = Number(value);
	if (
		value < 0n ||
		!Number.isSafeInteger(numberValue) ||
		BigInt(numberValue) !== value
	) {
		throw new Error(`${label} is outside the safe file-offset range: ${value}`);
	}
	return numberValue;
}

function rangesOverlapContainer(
	innerOffset: bigint,
	innerSize: bigint,
	outerOffset: bigint,
	outerSize: bigint,
): boolean {
	return (
		innerOffset >= outerOffset &&
		innerSize >= 0n &&
		outerSize >= 0n &&
		innerOffset + innerSize <= outerOffset + outerSize
	);
}

export function validateNativeBunSectionLayout(
	layout: NativeBunSectionLayout,
	artifactSize: number,
): NativeBunSectionLayout {
	if (!Number.isSafeInteger(artifactSize) || artifactSize < 0) {
		throw new Error(`Invalid native artifact size: ${artifactSize}`);
	}
	if (
		!Number.isSafeInteger(layout.fileOffset) ||
		!Number.isSafeInteger(layout.fileSize) ||
		layout.fileOffset < 0 ||
		layout.fileSize <= 0 ||
		layout.fileOffset + layout.fileSize > artifactSize
	) {
		throw new Error(
			`${layout.sectionName} range (${layout.fileOffset}+${layout.fileSize}) exceeds native artifact (${artifactSize} bytes)`,
		);
	}
	if (layout.virtualAddress < 0n || layout.virtualSize <= 0n) {
		throw new Error(
			`${layout.sectionName} has an invalid virtual range (${layout.virtualAddress}+${layout.virtualSize})`,
		);
	}

	const segmentFields = [
		layout.segmentName,
		layout.segmentFileOffset,
		layout.segmentFileSize,
		layout.segmentVirtualAddress,
		layout.segmentVirtualSize,
	];
	const hasAnySegmentField = segmentFields.some((value) => value !== undefined);
	const hasEverySegmentField = segmentFields.every(
		(value) => value !== undefined,
	);
	if (hasAnySegmentField !== hasEverySegmentField) {
		throw new Error("Mach-O Bun segment metadata is incomplete");
	}
	if (hasEverySegmentField) {
		const segmentFileOffset = layout.segmentFileOffset as number;
		const segmentFileSize = layout.segmentFileSize as number;
		const segmentVirtualAddress = layout.segmentVirtualAddress as bigint;
		const segmentVirtualSize = layout.segmentVirtualSize as bigint;
		if (
			!Number.isSafeInteger(segmentFileOffset) ||
			!Number.isSafeInteger(segmentFileSize) ||
			segmentFileOffset < 0 ||
			segmentFileSize <= 0 ||
			layout.fileOffset < segmentFileOffset ||
			layout.fileOffset + layout.fileSize > segmentFileOffset + segmentFileSize
		) {
			throw new Error(`${layout.sectionName} is outside its Mach-O segment`);
		}
		if (
			!rangesOverlapContainer(
				layout.virtualAddress,
				layout.virtualSize,
				segmentVirtualAddress,
				segmentVirtualSize,
			)
		) {
			throw new Error(
				`${layout.sectionName} virtual range is outside its Mach-O segment`,
			);
		}
	}

	return layout;
}

export function locateLiefBunSection(filePath: string): NativeBunSectionLayout {
	const artifactSize = fs.statSync(filePath).size;
	const lief = loadNodeLief();
	let binary: ReturnType<NodeLiefModule["parse"]>;
	try {
		binary = lief.parse(filePath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to parse native binary ${filePath}: ${detail}`, {
			cause: error,
		});
	}

	if (binary.format === "PE") {
		const section = binary.getSection(".bun");
		if (!section) throw new Error("PE .bun section not found");
		return validateNativeBunSectionLayout(
			{
				format: "PE",
				sectionName: ".bun",
				fileOffset: safeBigIntToNumber(
					"PE .bun file offset",
					section.fileOffset,
				),
				fileSize: safeBigIntToNumber("PE .bun file size", section.size),
				virtualAddress: section.virtualAddress,
				virtualSize: section.virtualSize,
				hasCodeSignature: null,
			},
			artifactSize,
		);
	}

	if (binary.format === "MachO") {
		const segment = binary.getSegment("__BUN");
		const section = segment?.getSection("__bun");
		if (!segment || !section) {
			throw new Error("Mach-O __BUN/__bun section not found");
		}
		return validateNativeBunSectionLayout(
			{
				format: "MachO",
				sectionName: "__bun",
				segmentName: "__BUN",
				fileOffset: safeBigIntToNumber(
					"Mach-O __bun file offset",
					section.fileOffset,
				),
				fileSize: safeBigIntToNumber("Mach-O __bun file size", section.size),
				virtualAddress: section.virtualAddress,
				virtualSize: section.size,
				segmentFileOffset: safeBigIntToNumber(
					"Mach-O __BUN segment file offset",
					segment.fileOffset,
				),
				segmentFileSize: safeBigIntToNumber(
					"Mach-O __BUN segment file size",
					segment.fileSize,
				),
				segmentVirtualAddress: segment.virtualAddress,
				segmentVirtualSize: segment.virtualSize,
				hasCodeSignature: binary.hasCodeSignature,
			},
			artifactSize,
		);
	}

	throw new Error(
		`Unsupported native binary format from node-lief: ${binary.format}`,
	);
}
