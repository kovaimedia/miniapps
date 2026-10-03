#!/usr/bin/env bun
// Verifies GET and HEAD on /generated/* return matching status/headers (and that
// HEAD carries no body) for both an existing file and a nonexistent one.
//
// Run: bun run test-generated-route.ts

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "swpix-generated-test-"));
process.env.GENERATED_IMAGES_DIR = TEST_DIR;

// Dynamic import so it picks up GENERATED_IMAGES_DIR set above (a static import
// would be hoisted and evaluate the module, reading the env var, before this runs).
const { storeGeneratedImage } = await import("./imageStore");

const PORT = 3999;
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]); // content doesn't matter, just real bytes
const relPath = storeGeneratedImage(FAKE_JPEG.toString("base64"), "image/jpeg");

console.log("Test file stored at:", relPath);

const proc = Bun.spawn({
  cmd: ["bun", "run", "server.ts"],
  cwd: import.meta.dir,
  env: { ...process.env, PORT: String(PORT), GENERATED_IMAGES_DIR: TEST_DIR, AUTH_USERS: "test:test" },
  stdout: "pipe",
  stderr: "pipe",
});

async function waitForServer(url: string, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not start in time");
}

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

try {
  await waitForServer(`http://localhost:${PORT}/`);

  const existingUrl = `http://localhost:${PORT}/generated/${relPath}`;
  const missingUrl = `http://localhost:${PORT}/generated/2099/01/01/00000000-0000-0000-0000-000000000000.jpg`;

  console.log("\nExisting file:");
  const get1 = await fetch(existingUrl, { method: "GET" });
  const getBody = await get1.arrayBuffer();
  const head1 = await fetch(existingUrl, { method: "HEAD" });
  const headBody = await head1.arrayBuffer();

  check("GET status 200", get1.status === 200, String(get1.status));
  check("HEAD status matches GET", head1.status === get1.status, `GET=${get1.status} HEAD=${head1.status}`);
  check(
    "HEAD Content-Type matches GET",
    head1.headers.get("content-type") === get1.headers.get("content-type"),
    `GET=${get1.headers.get("content-type")} HEAD=${head1.headers.get("content-type")}`
  );
  check(
    "HEAD Content-Length matches GET",
    head1.headers.get("content-length") === get1.headers.get("content-length"),
    `GET=${get1.headers.get("content-length")} HEAD=${head1.headers.get("content-length")}`
  );
  check(
    "HEAD Content-Length matches actual file size",
    head1.headers.get("content-length") === String(getBody.byteLength),
    `header=${head1.headers.get("content-length")} actual=${getBody.byteLength}`
  );
  check("HEAD body is empty", headBody.byteLength === 0, `got ${headBody.byteLength} bytes`);

  console.log("\nNonexistent file:");
  const get2 = await fetch(missingUrl, { method: "GET" });
  const head2 = await fetch(missingUrl, { method: "HEAD" });
  const head2Body = await head2.arrayBuffer();

  check("GET status 404", get2.status === 404, String(get2.status));
  check("HEAD status matches GET (404)", head2.status === get2.status, `GET=${get2.status} HEAD=${head2.status}`);
  check("HEAD body is empty on 404", head2Body.byteLength === 0, `got ${head2Body.byteLength} bytes`);
} finally {
  proc.kill();
  rmSync(TEST_DIR, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
