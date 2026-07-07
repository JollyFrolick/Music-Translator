import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

await Promise.all([
  readFile(join(root, "index.html")),
  readFile(join(root, "src", "main.js")),
  readFile(join(root, "src", "styles.css")),
  readFile(join(root, "public", "manifest.webmanifest")),
  readFile(join(root, "public", "sw.js")),
  readFile(join(root, "public", "icon.svg"))
]);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, "index.html"), join(dist, "index.html"));
await cp(join(root, "src"), join(dist, "src"), { recursive: true });
await cp(join(root, "public"), dist, { recursive: true });

console.log("Static app built to dist.");
