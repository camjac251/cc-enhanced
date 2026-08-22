interface ParsedReleaseVersion {
	core: string[];
	prerelease: string[] | null;
}

function parseReleaseVersion(value: string): ParsedReleaseVersion {
	const withoutBuild = value.split("+", 1)[0] ?? value;
	const prereleaseIndex = withoutBuild.indexOf("-");
	const core = (
		prereleaseIndex === -1
			? withoutBuild
			: withoutBuild.slice(0, prereleaseIndex)
	).split(".");
	const prerelease =
		prereleaseIndex === -1
			? null
			: withoutBuild.slice(prereleaseIndex + 1).split(".");
	return { core, prerelease };
}

function compareNumericIdentifier(left: string, right: string): number {
	const normalizedLeft = left.replace(/^0+(?=\d)/, "");
	const normalizedRight = right.replace(/^0+(?=\d)/, "");
	if (normalizedLeft.length !== normalizedRight.length) {
		return normalizedLeft.length - normalizedRight.length;
	}
	if (normalizedLeft === normalizedRight) return 0;
	return normalizedLeft < normalizedRight ? -1 : 1;
}

export function compareReleaseVersions(left: string, right: string): number {
	const parsedLeft = parseReleaseVersion(left);
	const parsedRight = parseReleaseVersion(right);
	for (
		let index = 0;
		index < Math.max(parsedLeft.core.length, parsedRight.core.length);
		index += 1
	) {
		const difference = compareNumericIdentifier(
			parsedLeft.core[index] ?? "0",
			parsedRight.core[index] ?? "0",
		);
		if (difference !== 0) return difference;
	}

	if (parsedLeft.prerelease === null && parsedRight.prerelease === null) {
		return 0;
	}
	if (parsedLeft.prerelease === null) return 1;
	if (parsedRight.prerelease === null) return -1;

	for (
		let index = 0;
		index <
		Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
		index += 1
	) {
		const leftPart = parsedLeft.prerelease[index];
		const rightPart = parsedRight.prerelease[index];
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		if (leftPart === rightPart) continue;
		const leftIsNumeric = /^\d+$/.test(leftPart);
		const rightIsNumeric = /^\d+$/.test(rightPart);
		if (leftIsNumeric && rightIsNumeric) {
			return compareNumericIdentifier(leftPart, rightPart);
		}
		if (leftIsNumeric) return -1;
		if (rightIsNumeric) return 1;
		return leftPart < rightPart ? -1 : 1;
	}
	return 0;
}
