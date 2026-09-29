import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

// Only the plugin root is redirected; the manifest reader, directory lister and
// containment check stay real so the test exercises the actual discovery path.
const pluginsRoot = vi.hoisted(() => ({ value: "" }));
vi.mock("./plugins.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("./plugins.ts")>()),
	defaultStepPluginsDir: () => pluginsRoot.value,
}));
const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./config-toml.ts", () => ({ readGlobalStepConfig: () => config.value }));

const { discoverStepMcpServers, resolvePluginServerCwd } = await import("./mcp.ts");

const cleanups: string[] = [];
afterEach(async () => {
	config.value = {};
	for (const dir of cleanups.splice(0).reverse()) await rm(dir, { recursive: true, force: true });
});

async function makePluginDir(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "step-plugin-cwd-"));
	cleanups.push(root);
	const pluginDir = path.join(root, "plugins", "demo");
	await mkdir(pluginDir, { recursive: true });
	pluginsRoot.value = path.join(root, "plugins");
	return pluginDir;
}

async function installPlugin(manifest: Record<string, unknown>): Promise<string> {
	const pluginDir = await makePluginDir();
	await writeFile(path.join(pluginDir, "step.plugin.json"), JSON.stringify(manifest), "utf8");
	return pluginDir;
}

const stdio = { command: "node", args: ["server/index.mjs"] };

test("a plugin server with no cwd starts in the plugin root", () => {
	expect(resolvePluginServerCwd("/plugins/demo", { ...stdio })?.cwd).toBe(path.resolve("/plugins/demo"));
});

test('a relative cwd of "." is read against the plugin root, not the process', () => {
	expect(resolvePluginServerCwd("/plugins/demo", { ...stdio, cwd: "." })?.cwd).toBe(path.resolve("/plugins/demo"));
});

test("a relative cwd names a directory inside the plugin", () => {
	expect(resolvePluginServerCwd("/plugins/demo", { ...stdio, cwd: "./server" })?.cwd).toBe(
		path.resolve("/plugins/demo/server"),
	);
});

test("a cwd that escapes the plugin is refused rather than rewritten", () => {
	for (const cwd of ["..", "../elsewhere", "server/../../.."]) {
		expect(resolvePluginServerCwd("/plugins/demo", { ...stdio, cwd })).toBeUndefined();
	}
});

test("an absolute cwd is the author's choice and is left untouched", () => {
	const absolute = path.resolve("/somewhere/else");
	expect(resolvePluginServerCwd("/plugins/demo", { ...stdio, cwd: absolute })?.cwd).toBe(absolute);
});

test("a declaration with no command never reaches the spawn path", () => {
	expect(resolvePluginServerCwd("/plugins/demo", { url: "https://example.test/mcp" })).toBeUndefined();
});

test("the caller's declaration is not mutated", () => {
	const original = { ...stdio };
	resolvePluginServerCwd("/plugins/demo", original);
	expect(original).toEqual(stdio);
});

test("fields other than cwd survive the anchor", () => {
	const declaration = {
		...stdio,
		env: { TOKEN: "x" },
		http_headers: { Accept: "text/event-stream" },
		startup_timeout_sec: 12,
		oauth: { client_id: "id" },
	};
	expect(resolvePluginServerCwd("/plugins/demo", declaration)).toEqual({
		...declaration,
		cwd: path.resolve("/plugins/demo"),
	});
});

test("discovery anchors an installed plugin to its own root", async () => {
	const pluginDir = await installPlugin({
		id: "demo",
		name: "Demo",
		version: "1.0.0",
		mcpServers: { demo: { ...stdio } },
	});

	const demo = (await discoverStepMcpServers(process.cwd(), false)).find((s) => s.name === "demo__demo");
	expect(demo?.declaration.cwd).toBe(path.resolve(pluginDir));
	expect(demo?.declaration.args).toEqual(["server/index.mjs"]);
});

test("discovery drops a plugin server whose cwd escapes the plugin", async () => {
	await installPlugin({
		id: "demo",
		name: "Demo",
		version: "1.0.0",
		mcpServers: { demo: { ...stdio, cwd: "../elsewhere" } },
	});

	expect(await discoverStepMcpServers(process.cwd(), false)).toHaveLength(0);
});

test("a global config.toml server is not anchored to any plugin", async () => {
	await makePluginDir();
	config.value = { mcp_servers: { local: { ...stdio } } };

	const local = (await discoverStepMcpServers(process.cwd(), false)).find((s) => s.name === "local");
	expect(local).toBeDefined();
	expect(local?.declaration.cwd).toBeUndefined();
});

test("a remote plugin declaration is not discovered as a stdio server", async () => {
	await installPlugin({
		id: "demo",
		name: "Demo",
		version: "1.0.0",
		mcpServers: { demo: { url: "https://example.test/mcp" } },
	});

	expect(await discoverStepMcpServers(process.cwd(), false)).toHaveLength(0);
});
