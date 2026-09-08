import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
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
});
