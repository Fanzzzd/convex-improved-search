import { access, readFile } from "node:fs/promises";
import { stdout } from "node:process";
import { URL } from "node:url";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

for (const [name, declaration] of Object.entries(packageJson.exports)) {
	const targets = typeof declaration === "string" ? { source: declaration } : declaration;
	for (const [condition, target] of Object.entries(targets)) {
		const url = new URL(target, root);
		try {
			await access(url);
		} catch {
			throw new Error(`Export ${name} (${condition}) points to missing ${target}`);
		}
		if (condition === "default") await import(url.href);
	}
}

stdout.write("Verified every declared package export target.\n");
