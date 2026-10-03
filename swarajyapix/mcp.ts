// Exposes image generation as MCP tools (generate_image, edit_image) over Streamable HTTP.
// Served from server.ts at /mcp/<MCP_SECRET> using the SDK's Web Standards transport,
// so it plugs directly into Bun.serve's fetch handler — no extra process or port.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { produceVerified } from "./gemini";
import { storeGeneratedImage } from "./imageStore";
import { createBulkJob, setBulkJobItem, getBulkJob, type BulkJobItem } from "./bulkJobStore";

const DEFAULT_ASPECT_RATIO = "3:2";
const DEFAULT_IMAGE_SIZE = "1K";
const MAX_BULK_PROMPTS = 15;
const BULK_STAGGER_MS = 2000; // stagger kickoffs so 15 concurrent calls don't all hit Gemini in the same instant

function verifiedSummary(rounds: number, unresolved: string[], url: string): string {
  const status =
    unresolved.length > 0
      ? `Verifier still flags: ${unresolved.join("; ")}`
      : `Verified${rounds > 0 ? ` (auto-corrected ${rounds}x)` : ""}.`;
  return `${status} Image URL (pass this to other tools that need it): ${url}`;
}

function buildServer(origin: string): McpServer {
  const server = new McpServer({ name: "swarajyapix", version: "1.0.0" });

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image from a text prompt with Gemini. The result is always checked by a " +
        "second AI pass against the prompt (wrong/missing subjects, bad counts, misspelled or stray " +
        "rendered text — including prompt labels like \"HEADLINE:\" leaking into the image — style " +
        "violations) and auto-corrected up to 2 times before being returned.",
      inputSchema: {
        prompt: z.string().min(1).describe("Text description of the image to generate"),
        aspectRatio: z.string().optional().describe('e.g. "3:2", "16:9", "1:1" (default "3:2")'),
        imageSize: z.enum(["1K", "2K", "4K"]).optional().describe('Default "1K"'),
      },
    },
    async ({ prompt, aspectRatio, imageSize }) => {
      const ar = aspectRatio || DEFAULT_ASPECT_RATIO;
      const size = imageSize || DEFAULT_IMAGE_SIZE;
      try {
        const { result, rounds, unresolved } = await produceVerified(prompt, ar, size, () => {});
        const relPath = storeGeneratedImage(result.image, result.mimeType);
        const url = `${origin}/generated/${relPath}`;
        return {
          content: [
            { type: "image" as const, data: result.image, mimeType: result.mimeType },
            { type: "text" as const, text: verifiedSummary(rounds, unresolved, url) },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message || String(err) }], isError: true };
      }
    }
  );

  server.registerTool(
    "generate_images",
    {
      description:
        `Start generating up to ${MAX_BULK_PROMPTS} images from a list of text prompts. Returns a job id ` +
        "immediately — it does NOT wait for the images, because a full batch (each image takes 30-90s " +
        "including verification, so a slow one or two can push the batch past a few minutes) can take " +
        "longer than a single tool call should block for. Call get_images with the returned jobId to check " +
        "progress and collect URLs as they finish; call it again later for any still-pending ones.",
      inputSchema: {
        prompts: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_BULK_PROMPTS)
          .describe(`1 to ${MAX_BULK_PROMPTS} text prompts, one per image`),
        aspectRatio: z.string().optional().describe('Applies to all images, e.g. "3:2" (default "3:2")'),
        imageSize: z.enum(["1K", "2K", "4K"]).optional().describe('Applies to all images (default "1K")'),
      },
    },
    async ({ prompts, aspectRatio, imageSize }) => {
      const ar = aspectRatio || DEFAULT_ASPECT_RATIO;
      const size = imageSize || DEFAULT_IMAGE_SIZE;

      const jobId = createBulkJob(prompts);

      // Fire and forget: runs after this handler returns. bulkJobStore is module-level
      // state shared across requests, so a later get_images call (a different HTTP
      // request, different McpServer instance) still sees updates written here.
      prompts.forEach((prompt, i) => {
        setTimeout(async () => {
          try {
            const { result, rounds, unresolved } = await produceVerified(prompt, ar, size, () => {});
            const relPath = storeGeneratedImage(result.image, result.mimeType);
            setBulkJobItem(jobId, i, {
              prompt,
              status: "done",
              url: `${origin}/generated/${relPath}`,
              verified: unresolved.length === 0,
              rounds,
              problems: unresolved,
            });
          } catch (err: any) {
            setBulkJobItem(jobId, i, { prompt, status: "error", error: err.message || String(err) });
          }
        }, i * BULK_STAGGER_MS);
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Started job ${jobId} for ${prompts.length} image(s). Call get_images with jobId "${jobId}" ` +
              "in a little while to check progress and get URLs as they finish.",
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_images",
    {
      description:
        "Check progress on a job started by generate_images and collect whichever images are done so far. " +
        "Safe to call repeatedly — call it again later for prompts still pending.",
      inputSchema: {
        jobId: z.string().min(1).describe("The job id returned by generate_images"),
      },
    },
    async ({ jobId }) => {
      const items = getBulkJob(jobId);
      if (!items) {
        return {
          content: [{ type: "text" as const, text: `No such job: ${jobId} (it may have expired).` }],
          isError: true,
        };
      }

      const done = items.filter((i: BulkJobItem) => i.status !== "pending").length;
      const lines = items.map((item: BulkJobItem, i: number) => {
        if (item.status === "pending") return `${i + 1}. pending — "${item.prompt.slice(0, 60)}"`;
        if (item.status === "error") return `${i + 1}. FAILED — "${item.prompt.slice(0, 60)}" — ${item.error}`;
        const status = item.verified
          ? `verified${item.rounds ? ` (auto-corrected ${item.rounds}x)` : ""}`
          : `flagged: ${(item.problems || []).join("; ")}`;
        return `${i + 1}. ${status} — ${item.url}`;
      });

      return { content: [{ type: "text" as const, text: `${done}/${items.length} done.\n${lines.join("\n")}` }] };
    }
  );

  server.registerTool(
    "edit_image",
    {
      description:
        "Edit an existing image with a text instruction using Gemini. The result is always checked " +
        "by a second AI pass against the instruction (and the original prompt, if given — including prompt " +
        "labels like \"HEADLINE:\" leaking into the image) and auto-corrected up to 2 times before being returned.",
      inputSchema: {
        image: z.string().min(1).describe("Base64-encoded source image"),
        mimeType: z.string().min(1).describe('Source image MIME type, e.g. "image/png"'),
        instruction: z.string().min(1).describe("What to change about the image"),
        originalPrompt: z
          .string()
          .optional()
          .describe("The original generation prompt, if known, so the verifier checks the full intent"),
        aspectRatio: z.string().optional().describe('e.g. "3:2", "16:9", "1:1" (default "3:2")'),
        imageSize: z.enum(["1K", "2K", "4K"]).optional().describe('Default "1K"'),
      },
    },
    async ({ image, mimeType, instruction, originalPrompt, aspectRatio, imageSize }) => {
      const ar = aspectRatio || DEFAULT_ASPECT_RATIO;
      const size = imageSize || DEFAULT_IMAGE_SIZE;
      try {
        const requirement = originalPrompt
          ? `Original request: ${originalPrompt}\nUser correction that MUST be applied: ${instruction}`
          : instruction;
        const { result, rounds, unresolved } = await produceVerified(requirement, ar, size, () => {}, {
          image,
          mimeType,
          instruction,
        });
        const relPath = storeGeneratedImage(result.image, result.mimeType);
        const url = `${origin}/generated/${relPath}`;
        return {
          content: [
            { type: "image" as const, data: result.image, mimeType: result.mimeType },
            { type: "text" as const, text: verifiedSummary(rounds, unresolved, url) },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message || String(err) }], isError: true };
      }
    }
  );

  return server;
}

function originOf(req: Request): string {
  const reqUrl = new URL(req.url);
  // Behind Railway's edge, req.url's scheme is the internal proxy->container hop
  // (always http), not what the client actually used — trust X-Forwarded-Proto
  // for the externally-visible scheme, falling back to the request's own for local dev.
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return `${forwardedProto || reqUrl.protocol.replace(":", "")}://${reqUrl.host}`;
}

// Stateless: a fresh server+transport per request, no session tracking across calls.
export async function handleMcpRequest(req: Request): Promise<Response> {
  const origin = originOf(req);
  const server = buildServer(origin);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
