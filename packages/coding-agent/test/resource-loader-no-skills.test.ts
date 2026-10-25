import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

const roots: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} instructions\n---\nUse ${name}.`);
}

describe("--no-skills discovery", () => {
	it("does not traverse default, configured or package skill directories", async () => {
		const root = mkdtempSync(join(tmpdir(), "step-no-skills-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		const defaultDir = join(agentDir, "skills");
		const configuredDir = join(root, "configured");
		const packageDir = join(root, "package");
		const packageSkills = join(packageDir, "skills");
		for (const [dir, name] of [
			[defaultDir, "default-skill"],
			[configuredDir, "configured-skill"],
			[packageSkills, "package-skill"],
		]) {
			writeSkill(join(dir, name), name);
		}
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "skills-package", version: "1.0.0", pi: { skills: ["skills"] } }),
		);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noExtensions: true,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory({ skills: [configuredDir], packages: [packageDir] }),
		});
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		const visited = vi.mocked(readdirSync).mock.calls.map(([path]) => String(path));
		expect(
			visited.some((path) =>
				[defaultDir, configuredDir, packageSkills].some((dir) => path === dir || path.startsWith(dir + sep)),
			),
		).toBe(false);
	});

	it("still discovers explicitly supplied skill directories", async () => {
		const root = mkdtempSync(join(tmpdir(), "step-explicit-skills-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const explicitDir = join(root, "explicit");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeSkill(join(explicitDir, "explicit-skill"), "explicit-skill");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noExtensions: true,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory(),
			additionalSkillPaths: [explicitDir],
		});
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["explicit-skill"]);
	});

	it("does not reinterpret a skills-only convention package as an extension", async () => {
		const root = mkdtempSync(join(tmpdir(), "step-skills-package-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const packageDir = join(root, "package");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeSkill(join(packageDir, "skills", "package-skill"), "package-skill");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory({ packages: [packageDir] }),
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getSkills().skills).toEqual([]);
	});
});

describe("--no-skills on extension-contributed resources", () => {
	function extensionMeta(baseDir: string) {
		return { source: "extension:extra", scope: "temporary", origin: "top-level", baseDir } as const;
	}

	function writePlugin(root: string): { skillDir: string; promptFile: string; promptDir: string } {
		const skillDir = join(root, "plugin", "skills");
		const promptDir = join(root, "plugin", "commands");
		const promptFile = join(promptDir, "extra.md");
		writeSkill(join(skillDir, "plugin-skill"), "plugin-skill");
		mkdirSync(promptDir, { recursive: true });
		writeFileSync(promptFile, `---\ndescription: Extra prompt\n---\nExtra prompt content`);
		return { skillDir, promptFile, promptDir };
	}

	it("drops extension-contributed skills and prompt templates when the flags are set", async () => {
		const root = mkdtempSync(join(tmpdir(), "step-ext-flags-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const { skillDir, promptFile, promptDir } = writePlugin(root);

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noExtensions: true,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);

		loader.extendResources({
			skillPaths: [{ path: skillDir, metadata: extensionMeta(join(root, "plugin")) }],
			promptPaths: [{ path: promptFile, metadata: extensionMeta(promptDir) }],
		});

		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getPrompts().prompts).toEqual([]);
	});

	it("still loads extension-contributed skills when the flags are not set", async () => {
		const root = mkdtempSync(join(tmpdir(), "step-ext-noflags-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const { skillDir, promptFile, promptDir } = writePlugin(root);

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();

		loader.extendResources({
			skillPaths: [{ path: skillDir, metadata: extensionMeta(join(root, "plugin")) }],
			promptPaths: [{ path: promptFile, metadata: extensionMeta(promptDir) }],
		});

		// The machine's real ~/.agents/skills is also scanned (package-manager.ts uses
		// getHomeDir(), not the storage root), so assert presence rather than exact contents.
		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("plugin-skill");
		expect(loader.getPrompts().prompts.length).toBeGreaterThan(0);
	});
});
