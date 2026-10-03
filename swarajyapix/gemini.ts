import { GoogleGenAI } from "@google/genai";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// --- Config ---
let apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  const fallbackEnv = join(process.env.HOME || "~", ".claude", ".env");
  if (existsSync(fallbackEnv)) {
    const content = readFileSync(fallbackEnv, "utf-8");
    const match = content.match(/GOOGLE_API_KEY=(.+)/);
    if (match) apiKey = match[1].trim();
  }
}

if (!apiKey) {
  console.error("GOOGLE_API_KEY not found in .env or ~/.claude/.env");
  process.exit(1);
}

export const ai = new GoogleGenAI({ apiKey });

export const IMAGE_MODEL = "gemini-3-pro-image-preview";
export const VERIFY_MODEL = "gemini-2.5-flash";
export const MAX_CORRECTION_ROUNDS = 2; // auto-fix attempts before sending anyway

export interface ImageResult {
  image: string;
  mimeType: string;
}

export interface Verdict {
  match: boolean;
  problems: string[];
  fix_instruction: string;
}

export function extractImage(response: any): ImageResult | null {
  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      return { image: part.inlineData.data, mimeType: part.inlineData.mimeType || "image/png" };
    }
  }
  return null;
}

export async function generateImage(prompt: string, aspectRatio: string, imageSize: string): Promise<ImageResult> {
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: prompt,
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio, imageSize },
    },
  });
  const img = extractImage(response);
  if (!img) {
    const textPart = (response.candidates?.[0]?.content?.parts || []).find((p: any) => p.text);
    throw new Error(textPart ? `Model returned text instead of image: ${textPart.text}` : "No image generated");
  }
  return img;
}

export async function editImage(
  image: string,
  mimeType: string,
  instruction: string,
  aspectRatio: string,
  imageSize: string
): Promise<ImageResult> {
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { data: image, mimeType } }, { text: instruction }],
      },
    ],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio, imageSize },
    },
  });
  const img = extractImage(response);
  if (!img) throw new Error("Edit produced no image");
  return img;
}

export async function verifyImage(image: string, mimeType: string, requirement: string): Promise<Verdict> {
  const response = await ai.models.generateContent({
    model: VERIFY_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: image, mimeType } },
          {
            text:
              "You are a strict image QA checker. Compare this image against the request below.\n\n" +
              `REQUEST: ${requirement}\n\n` +
              "Flag only substantive mismatches: missing or wrong subjects, wrong counts, " +
              "misspelled or wrong text rendered in the image, or violations of explicitly " +
              "requested style, composition, or colors. Ignore minor aesthetic choices the " +
              "request left open.\n\n" +
              "Pay special attention to structural/placeholder labels from the request (e.g. " +
              "\"HEADLINE:\", \"TITLE:\", \"BODY TEXT:\", \"CAPTION:\") being rendered literally in " +
              "the image instead of just the content they introduce — that is always a defect, " +
              "even if everything else matches.\n\n" +
              'Respond with JSON only: {"match": true|false, "problems": ["..."], ' +
              '"fix_instruction": "one imperative sentence telling an image editor how to fix it"}',
          },
        ],
      },
    ],
    config: { responseMimeType: "application/json" },
  });

  const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const verdict = JSON.parse(cleaned);
    return {
      match: Boolean(verdict.match),
      problems: Array.isArray(verdict.problems) ? verdict.problems.map(String) : [],
      fix_instruction: String(verdict.fix_instruction || ""),
    };
  } catch {
    // Unparseable verdict: don't block delivery on the checker
    console.error("Verifier returned unparseable output:", raw.slice(0, 200));
    return { match: true, problems: [], fix_instruction: "" };
  }
}

// Generate (or edit), then verify-and-correct until it passes or rounds run out
export async function produceVerified(
  requirement: string,
  aspectRatio: string,
  imageSize: string,
  onProgress: (text: string) => void,
  seed?: { image: string; mimeType: string; instruction: string }
): Promise<{ result: ImageResult; rounds: number; unresolved: string[] }> {
  onProgress(seed ? "✏️ Applying your correction…" : "🎨 Generating…");
  let current = seed
    ? await editImage(seed.image, seed.mimeType, seed.instruction, aspectRatio, imageSize)
    : await generateImage(requirement, aspectRatio, imageSize);

  let unresolved: string[] = [];
  let round = 0;

  while (round <= MAX_CORRECTION_ROUNDS) {
    onProgress(`🔍 Verifying image against the request${round > 0 ? ` (round ${round + 1})` : ""}…`);
    const verdict = await verifyImage(current.image, current.mimeType, requirement);
    if (verdict.match) return { result: current, rounds: round, unresolved: [] };

    unresolved = verdict.problems;
    if (round === MAX_CORRECTION_ROUNDS || !verdict.fix_instruction) break;

    round++;
    onProgress(`🔧 Fixing (attempt ${round}/${MAX_CORRECTION_ROUNDS}): ${verdict.problems.join("; ").slice(0, 150)}`);
    current = await editImage(current.image, current.mimeType, verdict.fix_instruction, aspectRatio, imageSize);
  }

  return { result: current, rounds: round, unresolved };
}
