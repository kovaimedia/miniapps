// Persists images generated via MCP to the /data volume (see nixpacks/Railway volume
// "swarajyapix-generated" mounted at /data), organized as YYYY/MM/DD/<uuid>.<ext>, and
// serves them back over HTTP at GET /generated/<path> so an MCP tool result can hand
// other tools/clients a fetchable URL instead of relying on them being able to relay
// raw base64 (an "image" content block is a vision block — the model never sees its
// base64 as literal text, so it can't paste it into another tool's input).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const STORE_ROOT = process.env.GENERATED_IMAGES_DIR || join(import.meta.dir, "data", "generated");

const REL_PATH_PATTERN = /^\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

function extFor(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return "jpg";
}

function mimeTypeFor(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export function storeGeneratedImage(data: string, mimeType: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = String(now.getFullYear());
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());

  const dir = join(STORE_ROOT, year, month, day);
  mkdirSync(dir, { recursive: true });

  const filename = `${crypto.randomUUID()}.${extFor(mimeType)}`;
  writeFileSync(join(dir, filename), Buffer.from(data, "base64"));

  return `${year}/${month}/${day}/${filename}`;
}

export function getGeneratedImage(relPath: string): { buffer: Buffer; mimeType: string } | null {
  if (!REL_PATH_PATTERN.test(relPath)) return null; // reject anything that isn't exactly YYYY/MM/DD/<uuid>.ext

  const fullPath = join(STORE_ROOT, relPath);
  if (!existsSync(fullPath)) return null;

  const ext = relPath.split(".").pop()!;
  return { buffer: readFileSync(fullPath), mimeType: mimeTypeFor(ext) };
}
