import { defineConfig } from "vite";
export default defineConfig({
  build: {
    target: "es2020",
    lib: {
      entry: "src/main.ts",
      name: "JTalkWidget",
      formats: ["iife"],
      fileName: () => "widget.min.js",
    },
    sourcemap: false,
    minify: true,
    cssCodeSplit: false,
  },
});
