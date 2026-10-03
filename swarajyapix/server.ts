import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { ai, produceVerified } from "./gemini";
import { handleMcpRequest } from "./mcp";
import { getGeneratedImage } from "./imageStore";

const DEFAULT_IMAGE_SIZE = "1K";

// --- Auth: parse AUTH_USERS from env ---
const authUsers = new Map<string, string>();
const authUsersRaw = process.env.AUTH_USERS || "";
for (const pair of authUsersRaw.split(",")) {
  const trimmed = pair.trim();
  if (!trimmed) continue;
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    authUsers.set(trimmed.slice(0, colonIdx), trimmed.slice(colonIdx + 1));
  }
}

if (authUsers.size === 0) {
  console.warn("WARNING: AUTH_USERS is empty or not set. No users can log in.");
}

// Session store: token -> username
const sessions = new Map<string, string>();

// Rate limiter: username -> array of timestamps
const RATE_LIMIT = 10; // max requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute
const rateLimits = new Map<string, number[]>();

function checkRateLimit(username: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const timestamps = rateLimits.get(username) || [];
  const recent = timestamps.filter(t => now - t < RATE_WINDOW_MS);
  rateLimits.set(username, recent);

  if (recent.length >= RATE_LIMIT) {
    const oldest = recent[0];
    return { allowed: false, remaining: 0, retryAfterMs: RATE_WINDOW_MS - (now - oldest) };
  }

  recent.push(now);
  return { allowed: true, remaining: RATE_LIMIT - recent.length, retryAfterMs: 0 };
}

function validateToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  return sessions.get(token) || null;
}

// --- Batch storage ---
const BATCH_DIR = join(import.meta.dir, "data", "batches");
mkdirSync(BATCH_DIR, { recursive: true });

interface BatchRecord {
  id: string;
  createdAt: string;
  username: string;
  state: "pending" | "running" | "succeeded" | "failed" | "expired";
  batchJobName: string | null;
  prompts: string[];
  aspectRatio: string;
  imageSize: string;
  totalRequests: number;
  results?: { prompt: string; image: string; mimeType: string }[];
  error?: string;
  lastCheckedAt?: string;
}

function generateBatchId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `batch-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function saveBatch(batch: BatchRecord): void {
  writeFileSync(join(BATCH_DIR, `${batch.id}.json`), JSON.stringify(batch, null, 2));
}

function loadBatch(id: string): BatchRecord | null {
  const filePath = join(BATCH_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function listBatches(username: string): Omit<BatchRecord, "results">[] {
  const files = readdirSync(BATCH_DIR).filter(f => f.endsWith(".json"));
  const batches: BatchRecord[] = [];
  for (const file of files) {
    try {
      const batch: BatchRecord = JSON.parse(readFileSync(join(BATCH_DIR, file), "utf-8"));
      if (batch.username === username) batches.push(batch);
    } catch { /* skip corrupt files */ }
  }
  batches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  // Strip results (image data) from list response
  return batches.map(({ results, ...rest }) => rest);
}

// --- MCP: tools: generate_image, edit_image (see ./mcp.ts) ---
const MCP_SECRET = process.env.MCP_SECRET || "";

function mcpAuthed(req: Request, path: string): boolean {
  if (!MCP_SECRET) return false;
  if (path === `/mcp/${MCP_SECRET}`) return true;
  if (req.headers.get("authorization") === `Bearer ${MCP_SECRET}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get("key") === MCP_SECRET;
}

const server = Bun.serve({
  port: parseInt(process.env.PORT || "3000"),
  async fetch(req) {
    const url = new URL(req.url);

    // --- MCP endpoint (tools: generate_image, edit_image) ---
    // Only /mcp paths require auth; everything else falls through to the plain
    // 404 below so OAuth-discovery probes (/.well-known/*, /register) from
    // connector clients don't trigger a dynamic-registration attempt.
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!mcpAuthed(req, url.pathname)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return handleMcpRequest(req);
    }

    // --- GET/HEAD /generated/YYYY/MM/DD/<uuid>.ext — fetchable URL for images produced via MCP tools ---
    // HEAD must answer exactly like GET (same status/headers, no body) — callers that check an image
    // URL exists before using it (e.g. a posting tool verifying a URL, or the eventual image-host fetch
    // at publish time) commonly probe with HEAD first.
    const genMatch = url.pathname.match(/^\/generated\/(\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.(?:jpg|png|webp))$/);
    if (genMatch && (req.method === "GET" || req.method === "HEAD")) {
      const isHead = req.method === "HEAD";
      const entry = getGeneratedImage(genMatch[1]);

      if (!entry) {
        const notFoundBody = "Not found";
        return new Response(isHead ? null : notFoundBody, {
          status: 404,
          headers: {
            "Content-Type": "text/plain;charset=utf-8",
            "Content-Length": String(Buffer.byteLength(notFoundBody)),
          },
        });
      }

      return new Response(isHead ? null : entry.buffer, {
        status: 200,
        headers: {
          "Content-Type": entry.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Length": String(entry.buffer.length),
        },
      });
    }

    // Serve index.html at root
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(join(import.meta.dir, "index.html"), "utf-8");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // --- POST /api/login ---
    if (url.pathname === "/api/login" && req.method === "POST") {
      try {
        const body = await req.json();
        const { username, password } = body;

        if (!username || !password) {
          return Response.json(
            { error: "Username and password required" },
            { status: 400 }
          );
        }

        const storedPassword = authUsers.get(username);
        if (!storedPassword || storedPassword !== password) {
          return Response.json(
            { error: "Invalid credentials" },
            { status: 401 }
          );
        }

        const token = crypto.randomUUID();
        sessions.set(token, username);

        return Response.json({ token, username });
      } catch {
        return Response.json(
          { error: "Invalid request body" },
          { status: 400 }
        );
      }
    }

    // --- GET /api/me ---
    if (url.pathname === "/api/me" && req.method === "GET") {
      const username = validateToken(req);
      if (!username) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return Response.json({ username });
    }

    // --- POST /api/generate (auth-protected) ---
    if (url.pathname === "/api/generate" && req.method === "POST") {
      const username = validateToken(req);
      if (!username) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const rl = checkRateLimit(username);
      if (!rl.allowed) {
        return Response.json(
          { error: `Rate limit exceeded (${RATE_LIMIT}/min). Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
          { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
        );
      }

      try {
        const body = await req.json();
        let { prompt, aspectRatio = "3:2", imageSize } = body;

        // Unwrap nested prompt objects (e.g. {prompt: {prompt: "..."}})
        if (prompt && typeof prompt === "object" && prompt.prompt) {
          prompt = prompt.prompt;
        }

        if (!prompt || typeof prompt !== "string") {
          return Response.json(
            { error: "Missing or invalid 'prompt' field" },
            { status: 400 }
          );
        }

        const size = imageSize || DEFAULT_IMAGE_SIZE;

        const { result, rounds, unresolved } = await produceVerified(prompt, aspectRatio, size, () => {});
        return Response.json({
          image: result.image,
          mimeType: result.mimeType,
          prompt,
          verified: unresolved.length === 0,
          rounds,
          problems: unresolved,
        });
      } catch (err: any) {
        console.error("Generation error:", err);
        return Response.json(
          { error: err.message || "Generation failed" },
          { status: 500 }
        );
      }
    }

    // --- POST /api/parse-prompts (auth-protected, AI fallback) ---
    if (url.pathname === "/api/parse-prompts" && req.method === "POST") {
      const username = validateToken(req);
      if (!username) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const body = await req.json();
        const { text } = body;

        if (!text || typeof text !== "string") {
          return Response.json(
            { error: "Missing or invalid 'text' field" },
            { status: 400 }
          );
        }

        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: text,
          config: {
            systemInstruction:
              "Extract image generation prompts from the following content. " +
              "Return ONLY a valid JSON array of strings, each a descriptive image prompt. " +
              "If the input already contains prompts, clean them up. " +
              "If the input is an article or description, create visual prompts for key scenes/concepts. " +
              "Return valid JSON only, no markdown fencing.",
          },
        });

        const rawText =
          response.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // Strip markdown fencing if the model added it anyway
        const cleaned = rawText
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        let prompts: string[];
        try {
          prompts = JSON.parse(cleaned);
          if (!Array.isArray(prompts) || !prompts.every((p) => typeof p === "string")) {
            throw new Error("Expected array of strings");
          }
        } catch {
          return Response.json(
            { error: "AI could not extract prompts from this input" },
            { status: 422 }
          );
        }

        return Response.json({ prompts });
      } catch (err: any) {
        console.error("Parse-prompts error:", err);
        return Response.json(
          { error: err.message || "Failed to parse prompts" },
          { status: 500 }
        );
      }
    }

    // --- POST /api/edit-image (auth-protected) ---
    if (url.pathname === "/api/edit-image" && req.method === "POST") {
      const username = validateToken(req);
      if (!username) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const rl = checkRateLimit(username);
      if (!rl.allowed) {
        return Response.json(
          { error: `Rate limit exceeded (${RATE_LIMIT}/min). Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
          { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
        );
      }

      try {
        const body = await req.json();
        const { image, mimeType, prompt, aspectRatio = "3:2", imageSize, originalPrompt } = body;

        if (!image || !mimeType || !prompt) {
          return Response.json(
            { error: "Missing required fields: image, mimeType, prompt" },
            { status: 400 }
          );
        }

        const size = imageSize || DEFAULT_IMAGE_SIZE;

        // Verify against the full intent (original prompt + this correction), not just the instruction in isolation
        const requirement = originalPrompt
          ? `Original request: ${originalPrompt}\nUser correction that MUST be applied: ${prompt}`
          : prompt;

        const { result, rounds, unresolved } = await produceVerified(requirement, aspectRatio, size, () => {}, {
          image,
          mimeType,
          instruction: prompt,
        });

        return Response.json({
          image: result.image,
          mimeType: result.mimeType,
          prompt,
          verified: unresolved.length === 0,
          rounds,
          problems: unresolved,
        });
      } catch (err: any) {
        console.error("Edit-image error:", err);
        return Response.json(
          { error: err.message || "Edit failed" },
          { status: 500 }
        );
      }
    }

    // --- Serve batch.html ---
    if (url.pathname === "/batch" || url.pathname === "/batch.html") {
      const batchPath = join(import.meta.dir, "batch.html");
      if (existsSync(batchPath)) {
        const html = readFileSync(batchPath, "utf-8");
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Batch page not found", { status: 404 });
    }

    // --- POST /api/batch/create ---
    if (url.pathname === "/api/batch/create" && req.method === "POST") {
      const username = validateToken(req);
      if (!username) return Response.json({ error: "Unauthorized" }, { status: 401 });

      try {
        const body = await req.json();
        const { prompts: batchPrompts, aspectRatio = "3:2", imageSize = "1K" } = body;

        if (!Array.isArray(batchPrompts) || batchPrompts.length === 0) {
          return Response.json({ error: "prompts must be a non-empty array of strings" }, { status: 400 });
        }
        if (!batchPrompts.every((p: any) => typeof p === "string" && p.trim())) {
          return Response.json({ error: "All prompts must be non-empty strings" }, { status: 400 });
        }

        const batchId = generateBatchId();
        const imgConfig: Record<string, string> = { aspectRatio };
        if (imageSize) imgConfig.imageSize = imageSize;

        // Build inline request objects for Batch API
        // SDK expects: { contents, config } per request (it wraps them internally)
        const inlinedRequests = batchPrompts.map((prompt: string) => ({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: imgConfig,
          },
        }));

        // Call Gemini Batch API
        const batchResponse = await ai.batches.create({
          model: "gemini-3-pro-image-preview",
          src: inlinedRequests,
          config: { displayName: batchId },
        });

        const batchRecord: BatchRecord = {
          id: batchId,
          createdAt: new Date().toISOString(),
          username,
          state: "pending",
          batchJobName: batchResponse.name || null,
          prompts: batchPrompts,
          aspectRatio,
          imageSize,
          totalRequests: batchPrompts.length,
        };
        saveBatch(batchRecord);

        return Response.json({
          id: batchRecord.id,
          state: batchRecord.state,
          batchJobName: batchRecord.batchJobName,
          totalRequests: batchRecord.totalRequests,
          createdAt: batchRecord.createdAt,
        });
      } catch (err: any) {
        console.error("Batch create error:", err);
        return Response.json({ error: err.message || "Failed to create batch" }, { status: 500 });
      }
    }

    // --- GET /api/batch/list ---
    if (url.pathname === "/api/batch/list" && req.method === "GET") {
      const username = validateToken(req);
      if (!username) return Response.json({ error: "Unauthorized" }, { status: 401 });
      return Response.json({ batches: listBatches(username) });
    }

    // --- POST /api/batch/:id/poll ---
    const pollMatch = url.pathname.match(/^\/api\/batch\/([^/]+)\/poll$/);
    if (pollMatch && req.method === "POST") {
      const username = validateToken(req);
      if (!username) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const batchId = pollMatch[1];
      const batch = loadBatch(batchId);
      if (!batch || batch.username !== username) {
        return Response.json({ error: "Batch not found" }, { status: 404 });
      }

      // Skip if already in terminal state with results
      if (batch.state === "succeeded" && batch.results) {
        return Response.json({
          id: batch.id,
          state: batch.state,
          totalRequests: batch.totalRequests,
          imageCount: batch.results.length,
          lastCheckedAt: batch.lastCheckedAt,
        });
      }
      if (batch.state === "failed" || batch.state === "expired") {
        return Response.json({
          id: batch.id,
          state: batch.state,
          error: batch.error,
          lastCheckedAt: batch.lastCheckedAt,
        });
      }

      if (!batch.batchJobName) {
        return Response.json({ error: "Batch has no job name" }, { status: 500 });
      }

      try {
        const jobStatus = await ai.batches.get({ name: batch.batchJobName });
        batch.lastCheckedAt = new Date().toISOString();

        const stateStr = String(jobStatus.state || "");
        if (stateStr.includes("SUCCEEDED") || stateStr === "JOB_STATE_SUCCEEDED") {
          batch.state = "succeeded";

          // Extract results from response
          try {
            const batchResults: { prompt: string; image: string; mimeType: string }[] = [];
            const dest = jobStatus.dest as any;

            // Inline responses (for inline batch requests)
            const inlinedResponses = dest?.inlinedResponses;
            if (Array.isArray(inlinedResponses) && inlinedResponses.length > 0) {
              for (let i = 0; i < inlinedResponses.length; i++) {
                const resp = inlinedResponses[i];
                const parts = resp?.response?.candidates?.[0]?.content?.parts || [];
                const prompt = batch.prompts[i] || `Prompt ${i + 1}`;
                for (const part of parts) {
                  if (part.inlineData) {
                    batchResults.push({
                      prompt,
                      image: part.inlineData.data,
                      mimeType: part.inlineData.mimeType || "image/png",
                    });
                    break;
                  }
                }
              }
            }
            // File-based fallback
            else if (dest?.fileName) {
              const downloaded = await ai.files.download({ file: dest.fileName });
              const textContent = await downloaded.text();
              const lines = textContent.split("\n").filter((l: string) => l.trim());
              for (let i = 0; i < lines.length; i++) {
                const lineData = JSON.parse(lines[i]);
                const parts = lineData?.response?.candidates?.[0]?.content?.parts || [];
                const prompt = batch.prompts[i] || `Prompt ${i + 1}`;
                for (const part of parts) {
                  if (part.inlineData) {
                    batchResults.push({
                      prompt,
                      image: part.inlineData.data,
                      mimeType: part.inlineData.mimeType || "image/png",
                    });
                    break;
                  }
                }
              }
            }

            batch.results = batchResults;
            if (batchResults.length === 0) {
              batch.error = "Batch completed but no images found in response";
            }
          } catch (dlErr: any) {
            console.error("Batch result extraction error:", dlErr);
            batch.error = "Results extraction failed: " + (dlErr.message || "unknown error");
          }
        } else if (stateStr.includes("FAILED") || stateStr === "JOB_STATE_FAILED") {
          batch.state = "failed";
          batch.error = (jobStatus as any).error?.message || "Batch job failed";
        } else if (stateStr.includes("RUNNING") || stateStr === "JOB_STATE_RUNNING") {
          batch.state = "running";
        } else if (stateStr.includes("EXPIRED")) {
          batch.state = "expired";
        }
        // else remains pending

        saveBatch(batch);

        return Response.json({
          id: batch.id,
          state: batch.state,
          totalRequests: batch.totalRequests,
          imageCount: batch.results?.length || 0,
          error: batch.error,
          lastCheckedAt: batch.lastCheckedAt,
        });
      } catch (err: any) {
        console.error("Batch poll error:", err);
        return Response.json({ error: err.message || "Failed to check batch status" }, { status: 500 });
      }
    }

    // --- GET /api/batch/:id/results ---
    const resultsMatch = url.pathname.match(/^\/api\/batch\/([^/]+)\/results$/);
    if (resultsMatch && req.method === "GET") {
      const username = validateToken(req);
      if (!username) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const batchId = resultsMatch[1];
      const batch = loadBatch(batchId);
      if (!batch || batch.username !== username) {
        return Response.json({ error: "Batch not found" }, { status: 404 });
      }

      if (batch.state !== "succeeded" || !batch.results) {
        return Response.json({ error: "Batch not yet completed" }, { status: 400 });
      }

      return Response.json({
        id: batch.id,
        state: batch.state,
        results: batch.results,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`SwarajyaPix server running at http://localhost:${server.port}`);
console.log(`Auth users loaded: ${authUsers.size}`);

// Telegram bot runs in the same process when configured
if (process.env.TELEGRAM_BOT_TOKEN) {
  import("./bot");
}

console.log(MCP_SECRET ? "MCP endpoint enabled at /mcp/<secret>" : "MCP_SECRET not set; MCP endpoint disabled");
