import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, "node_modules", "@ffmpeg", "core", "dist", "esm");
const targetDir = join(root, "public", "ffmpeg");

mkdirSync(targetDir, { recursive: true });

for (const fileName of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  copyFileSync(join(sourceDir, fileName), join(targetDir, fileName));
}
