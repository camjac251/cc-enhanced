import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { type AddressInfo, createServer, type Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export interface HeavyOperationGuardOptions {
	operation: string;
	port?: number;
	env?: NodeJS.ProcessEnv;
}

export interface HeavyOperationLease {
	port: number;
	release(): Promise<void>;
}

interface HeavyOperationOwner {
	operation: string;
	pid: number;
	startedAt: string;
	token: string;
}

const DEFAULT_PORT = 43100 + ((process.getuid?.() ?? 0) % 1000);
const TOKEN_ENV = "CC_ENHANCED_HEAVY_OPERATION_TOKEN";

function ownerPath(port: number): string {
	return path.join(os.tmpdir(), `cc-enhanced-heavy-operation-${port}.json`);
}

function readOwner(port: number): HeavyOperationOwner | undefined {
	try {
		return JSON.parse(fs.readFileSync(ownerPath(port), "utf8"));
	} catch {
		return undefined;
	}
}

function listen(server: Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
			server.off("error", onError);
			resolve((server.address() as AddressInfo).port);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

export async function acquireHeavyOperationGuard(
	options: HeavyOperationGuardOptions,
): Promise<HeavyOperationLease> {
	const requestedPort = options.port ?? DEFAULT_PORT;
	const env = options.env ?? process.env;
	const inheritedToken = env[TOKEN_ENV];
	if (inheritedToken) {
		const owner = readOwner(requestedPort);
		if (owner?.token === inheritedToken) {
			return {
				port: requestedPort,
				async release() {},
			};
		}
		delete env[TOKEN_ENV];
	}

	const server = createServer();
	let port: number;
	try {
		port = await listen(server, requestedPort);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EADDRINUSE") throw error;
		const owner = readOwner(requestedPort);
		const activeOperation = owner?.operation ?? "Another heavy operation";
		throw new Error(
			`${activeOperation} is already running; refusing to overlap ${options.operation}`,
		);
	}

	const token = randomUUID();
	const metadataPath = ownerPath(port);
	try {
		fs.writeFileSync(
			metadataPath,
			`${JSON.stringify(
				{
					operation: options.operation,
					pid: process.pid,
					startedAt: new Date().toISOString(),
					token,
				} satisfies HeavyOperationOwner,
				null,
				2,
			)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		env[TOKEN_ENV] = token;
	} catch (error) {
		try {
			await closeServer(server);
		} catch (closeError) {
			throw new AggregateError(
				[error, closeError],
				`Failed to record or release the ${options.operation} guard`,
			);
		}
		throw error;
	}

	let released = false;
	return {
		port,
		async release() {
			if (released) return;
			released = true;
			await closeServer(server);
			const owner = readOwner(port);
			if (owner?.token === token) {
				fs.rmSync(metadataPath, { force: true });
			}
			if (env[TOKEN_ENV] === token) {
				delete env[TOKEN_ENV];
			}
		},
	};
}

export async function withHeavyOperationGuard<T>(
	options: HeavyOperationGuardOptions,
	work: (lease: HeavyOperationLease) => T | Promise<T>,
): Promise<T> {
	const lease = await acquireHeavyOperationGuard(options);
	try {
		return await work(lease);
	} finally {
		await lease.release();
	}
}
