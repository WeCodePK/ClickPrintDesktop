import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// The real release version only exists in CI: the release workflow resolves it
// from GitHub releases and writes it into package.json (working tree only)
// before this build runs. Reading package.json here stamps that version into
// the bundle. The dev server shows "dev", since the committed version is just
// a floor and not what any release is called.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export default defineConfig(({ command }) => ({
	plugins: [react()],
	define: {
		__APP_VERSION__: JSON.stringify(command === "serve" ? "dev" : version),
	},
	base: "./",
	// Static assets are shared with the main process, so they live in the
	// repo-level assets/ dir rather than a renderer-local public/.
	publicDir: "../assets",
	server: {
		port: 3001,
		strictPort: true,
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
}));
