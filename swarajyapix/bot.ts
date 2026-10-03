import { produceVerified, type ImageResult } from "./gemini";

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set; bot not starting.");
  process.exit(1);
}
if (ALLOWED_IDS.size === 0) {
  console.warn("WARNING: TELEGRAM_ALLOWED_IDS is empty. Nobody can use the bot.");
}

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

// --- Telegram API helpers ---
async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: any = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
  return data.result;
}

async function tgSendImage(
  chatId: number,
  imageB64: string,
  mimeType: string,
  caption: string,
  asDocument = false
): Promise<any> {
  const bytes = Buffer.from(imageB64, "base64");
  const ext = mimeType.includes("jpeg") ? "jpg" : "png";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption.slice(0, 1024));
  const field = asDocument ? "document" : "photo";
  form.append(field, new Blob([bytes], { type: mimeType }), `image.${ext}`);

  const res = await fetch(`${TG}/${asDocument ? "sendDocument" : "sendPhoto"}`, {
    method: "POST",
    body: form,
  });
  const data: any = await res.json();
  if (!data.ok) {
    // Photos over Telegram's limit fail; retry as document
    if (!asDocument) return tgSendImage(chatId, imageB64, mimeType, caption, true);
    throw new Error(`Telegram send failed: ${data.description}`);
  }
  return data.result;
}

function sendStatus(chatId: number, text: string): Promise<any> {
  return tg("sendMessage", { chat_id: chatId, text });
}

function editStatus(chatId: number, messageId: number, text: string): Promise<any> {
  return tg("editMessageText", { chat_id: chatId, message_id: messageId, text }).catch(() => {});
}

// --- Image store: message_id -> full-res image, so replies can chain edits ---
interface StoredImage {
  image: string; // base64
  mimeType: string;
  prompt: string; // cumulative intent (original prompt + applied corrections)
}
const imageStore = new Map<string, StoredImage>();
const IMAGE_STORE_MAX = 100;

function storeImage(chatId: number, messageId: number, entry: StoredImage): void {
  imageStore.set(`${chatId}:${messageId}`, entry);
  // FIFO trim so base64 blobs don't grow unbounded
  while (imageStore.size > IMAGE_STORE_MAX) {
    const oldest = imageStore.keys().next().value;
    if (!oldest) break;
    imageStore.delete(oldest);
  }
}

// Fallback after restart: pull the (compressed) image back from Telegram
async function fetchRepliedImage(replyMsg: any): Promise<StoredImage | null> {
  let fileId: string | null = null;
  let mimeType = "image/jpeg";
  if (Array.isArray(replyMsg.photo) && replyMsg.photo.length > 0) {
    fileId = replyMsg.photo[replyMsg.photo.length - 1].file_id; // largest size
  } else if (replyMsg.document?.mime_type?.startsWith("image/")) {
    fileId = replyMsg.document.file_id;
    mimeType = replyMsg.document.mime_type;
  }
  if (!fileId) return null;

  const file = await tg("getFile", { file_id: fileId });
  const res = await fetch(`${TG_FILE}/${file.file_path}`);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    image: buf.toString("base64"),
    mimeType,
    prompt: replyMsg.caption || "",
  };
}

// --- Per-user settings & throttling ---
const userSettings = new Map<number, { aspectRatio: string; imageSize: string }>();
function settingsFor(userId: number) {
  return userSettings.get(userId) || { aspectRatio: "3:2", imageSize: "1K" };
}

const inFlight = new Map<number, number>();
const MAX_IN_FLIGHT = 2;

// --- Request handling ---
async function handleGenerate(chatId: number, userId: number, prompt: string): Promise<void> {
  const { aspectRatio, imageSize } = settingsFor(userId);
  const status = await sendStatus(chatId, "🎨 Generating…");
  const progress = (text: string) => editStatus(chatId, status.message_id, text);

  const { result, rounds, unresolved } = await produceVerified(prompt, aspectRatio, imageSize, progress);

  let caption = prompt;
  if (unresolved.length > 0) {
    caption += `\n\n⚠️ Verifier still flags: ${unresolved.join("; ")}`.slice(0, 1024 - caption.length);
  } else if (rounds > 0) {
    caption += `\n\n✅ Verified (auto-corrected ${rounds}×)`;
  } else {
    caption += "\n\n✅ Verified";
  }

  const sent = await tgSendImage(chatId, result.image, result.mimeType, caption);
  storeImage(chatId, sent.message_id, { image: result.image, mimeType: result.mimeType, prompt });
  await tg("deleteMessage", { chat_id: chatId, message_id: status.message_id }).catch(() => {});
}

async function handleCorrection(chatId: number, userId: number, msg: any, correction: string): Promise<void> {
  const replyMsg = msg.reply_to_message;
  let stored = imageStore.get(`${chatId}:${replyMsg.message_id}`);
  if (!stored) {
    const fetched = await fetchRepliedImage(replyMsg);
    if (!fetched) {
      await sendStatus(chatId, "Couldn't find an image in the message you replied to.");
      return;
    }
    stored = fetched;
  }

  // "hd" on a reply = resend that image as an uncompressed document
  if (/^\/?hd$/i.test(correction.trim())) {
    await tgSendImage(chatId, stored.image, stored.mimeType, stored.prompt || "Full resolution", true);
    return;
  }

  const { aspectRatio, imageSize } = settingsFor(userId);
  const status = await sendStatus(chatId, "✏️ Applying your correction…");
  const progress = (text: string) => editStatus(chatId, status.message_id, text);

  // Verify against original intent plus the correction, so fixes don't undo the base prompt
  const requirement = stored.prompt
    ? `Original request: ${stored.prompt}\nUser correction that MUST be applied: ${correction}`
    : correction;

  const { result, rounds, unresolved } = await produceVerified(requirement, aspectRatio, imageSize, progress, {
    image: stored.image,
    mimeType: stored.mimeType,
    instruction: correction,
  });

  let caption = `${stored.prompt ? stored.prompt + "\n" : ""}✏️ ${correction}`;
  if (unresolved.length > 0) {
    caption += `\n\n⚠️ Verifier still flags: ${unresolved.join("; ")}`;
  } else {
    caption += `\n\n✅ Correction verified${rounds > 0 ? ` (auto-corrected ${rounds}×)` : ""}`;
  }

  const sent = await tgSendImage(chatId, result.image, result.mimeType, caption.slice(0, 1024));
  storeImage(chatId, sent.message_id, {
    image: result.image,
    mimeType: result.mimeType,
    prompt: `${stored.prompt} — ${correction}`.slice(0, 2000),
  });
  await tg("deleteMessage", { chat_id: chatId, message_id: status.message_id }).catch(() => {});
}

const HELP = `SwarajyaPix bot 🎨

Send any text → generates an image, verifies it matches your prompt, auto-corrects if needed, then sends.

Reply to an image with text → applies that correction (also verified).
Reply "hd" to an image → resends it at full resolution.

Commands:
/ar 16:9 — set aspect ratio (default 3:2)
/size 1K|2K|4K — set image size (default 1K)`;

async function handleMessage(msg: any): Promise<void> {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text: string = (msg.text || "").trim();
  if (!chatId || !userId || !text) return;

  if (!ALLOWED_IDS.has(String(userId))) {
    await sendStatus(chatId, `Not authorized. Your Telegram ID is ${userId} — ask the admin to add it.`).catch(() => {});
    return;
  }

  if (text === "/start" || text === "/help") {
    await sendStatus(chatId, HELP);
    return;
  }

  const arMatch = text.match(/^\/ar\s+(\d+:\d+)$/);
  if (arMatch) {
    userSettings.set(userId, { ...settingsFor(userId), aspectRatio: arMatch[1] });
    await sendStatus(chatId, `Aspect ratio set to ${arMatch[1]}`);
    return;
  }

  const sizeMatch = text.match(/^\/size\s+(1K|2K|4K)$/i);
  if (sizeMatch) {
    userSettings.set(userId, { ...settingsFor(userId), imageSize: sizeMatch[1].toUpperCase() });
    await sendStatus(chatId, `Image size set to ${sizeMatch[1].toUpperCase()}`);
    return;
  }

  const busy = inFlight.get(userId) || 0;
  if (busy >= MAX_IN_FLIGHT) {
    await sendStatus(chatId, "Still working on your previous requests — try again in a bit.");
    return;
  }

  inFlight.set(userId, busy + 1);
  try {
    if (msg.reply_to_message) {
      await handleCorrection(chatId, userId, msg, text);
    } else {
      await handleGenerate(chatId, userId, text);
    }
  } catch (err: any) {
    console.error("Bot request error:", err);
    await sendStatus(chatId, `❌ ${err.message || "Something went wrong"}`).catch(() => {});
  } finally {
    inFlight.set(userId, (inFlight.get(userId) || 1) - 1);
  }
}

// --- Long-polling loop ---
async function pollLoop(): Promise<void> {
  let offset = 0;
  console.log("Telegram bot polling started");
  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          // Fire and forget so one slow generation doesn't block other users
          handleMessage(update.message).catch(err => console.error("handleMessage error:", err));
        }
      }
    } catch (err: any) {
      console.error("Poll error:", err.message || err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

pollLoop();
