import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  // Empty, and deliberately present. Cloudflare's Workers build detects a Vite
  // project and edits this file to add its own plugin; with no plugins array to
  // find it aborts the whole build ("Cannot modify Vite config: could not find
  // a valid plugins array"). Nothing here needs a plugin otherwise.
  plugins: [],
  build: {
    sourcemap: true,
  },
});
