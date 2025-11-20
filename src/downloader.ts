import * as fs from "fs";
import * as path from "path";
import * as tar from "tar";
import * as semver from "semver";
import chalk from "chalk";

const NPM_REGISTRY = "https://registry.npmjs.org";
const PKG_NAME = "@anthropic-ai/claude-code";

interface Dist {
    tarball: string;
}

interface VersionMeta {
    dist: Dist;
}

interface PkgMeta {
    "dist-tags": { latest: string };
    versions: Record<string, VersionMeta>;
}

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
    }
    return res.json() as Promise<T>;
}

export async function getPackageMeta(): Promise<PkgMeta> {
    return fetchJson<PkgMeta>(`${NPM_REGISTRY}/${PKG_NAME}`);
}

export function getAllVersions(meta: PkgMeta): string[] {
    return Object.keys(meta.versions).sort((a, b) => {
        return semver.compare(a, b);
    });
}

export function getLatestVersion(meta: PkgMeta): string {
    return meta["dist-tags"].latest || getAllVersions(meta).pop()!;
}

export function versionExists(meta: PkgMeta, version: string): boolean {
    return version in meta.versions;
}

export function getTarballUrl(meta: PkgMeta, version: string): string {
    const vmeta = meta.versions[version];
    if (!vmeta) {
        throw new Error(`Version not found: ${version}`);
    }
    let url = vmeta.dist.tarball;
    if (!url) {
        const base = PKG_NAME.split("/").pop();
        url = `${NPM_REGISTRY}/${PKG_NAME}/-/${base}-${version}.tgz`;
    }
    return url;
}

export async function downloadAndExtract(version: string, destDir: string, meta?: PkgMeta) {
    if (!meta) {
        meta = await getPackageMeta();
    }
    
    const url = getTarballUrl(meta, version);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
         throw new Error(`Failed to download tarball from ${url}`);
    }

    // Create destination directory
    // Logic: if destDir ends with version, use it. Else append version?
    // The python script: vdir = dest_dir if dest_dir.name == version else (dest_dir / version)
    // We'll assume the caller passes the exact directory where 'package/' should appear.
    
    fs.mkdirSync(destDir, { recursive: true });

    // Convert stream to buffer (node native fetch returns web stream)
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract
    const tempFile = path.join(destDir, `package-${version}.tgz`);
    fs.writeFileSync(tempFile, buffer);
    
    await tar.extract({
        file: tempFile,
        cwd: destDir
    });
    
    fs.unlinkSync(tempFile);
}
