#!/usr/bin/env bun
/**
 * Helpdesk Triage Web App
 *
 * Single-file Bun server that serves a one-page web app for Freshdesk ticket triage.
 * Three API proxy routes keep keys server-side. All HTML/CSS/JS inline.
 *
 * ENV: FRESHDESK_API_KEY, FRESHDESK_DOMAIN, ANTHROPIC_API_KEY, USERS
 * Run: bun run server.ts
 */

// ── ENV ──────────────────────────────────────────────────────────────────────

const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;
const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN || "swarajyasubscriptions";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const USERS_RAW = process.env.USERS || "";
const GOOGLE_CHAT_WEBHOOK = process.env.GOOGLE_CHAT_WEBHOOK || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

// Model assignments — cheap Haiku for classify/grade, Sonnet for user-facing prose
const MODEL_DRAFT_REPLY = "claude-sonnet-4-6";   // customer-facing drafts — quality matters
const MODEL_TRIAGE      = "claude-haiku-4-5";    // classifier — trivial task, cheap
const MODEL_GRADE       = "claude-haiku-4-5";    // daily-review grader — 100% agreement with Sonnet, 3× cheaper
const MODEL_NARRATIVE   = "claude-sonnet-4-6";   // daily digest opening prose — user reads this

// Grade cache — skip re-grading when nothing changed since last run
const GRADE_CACHE_PATH = "./grades-cache.json";
const GRADE_BATCH_SIZE = 10;  // grader batches N tickets per Claude call

// Parse USERS env: "amar:pass1,raghu:pass2:fd_apikey,..." → Maps
// Third field per user is an optional Freshdesk API key; falls back to FRESHDESK_API_KEY.
const USERS = new Map<string, string>();
const USER_KEYS = new Map<string, string>();
for (const entry of USERS_RAW.split(",")) {
  const parts = entry.split(":");
  if (parts.length < 2) continue;
  const user = parts[0].trim().toLowerCase();
  const pass = parts[1].trim();
  const apikey = parts.slice(2).join(":").trim();
  if (!user || !pass) continue;
  USERS.set(user, pass);
  if (apikey) USER_KEYS.set(user, apikey);
}

const BASE_URL = `https://${FRESHDESK_DOMAIN}.freshdesk.com`;
const AUTH_HEADER = `Basic ${btoa(`${FRESHDESK_API_KEY}:X`)}`;
const MAX_RETRIES = 3;
const CONCURRENCY = 5;
const PORT = parseInt(process.env.PORT || "3847", 10);

// Check env vars - warn but don't exit (allows health checks during deploy)
function checkEnvVars(): string[] {
  const missing: string[] = [];
  if (!FRESHDESK_API_KEY) missing.push("FRESHDESK_API_KEY");
  if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (USERS.size === 0) missing.push("USERS");
  return missing;
}

const missingEnvVars = checkEnvVars();
if (missingEnvVars.length) {
  console.warn(`⚠️  Missing env vars: ${missingEnvVars.join(", ")} - app will return 503 until configured`);
}

// ── Sessions ─────────────────────────────────────────────────────────────────

interface Session {
  username: string;
  createdAt: number;
}

const sessions = new Map<string, Session>();

function createSession(username: string): string {
  const token = crypto.randomUUID();
  sessions.set(token, { username, createdAt: Date.now() });
  return token;
}

function getSession(req: Request): Session | null {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  return sessions.get(match[1]) || null;
}

function validSession(req: Request): boolean {
  return getSession(req) !== null;
}

/** Per-request Freshdesk auth header. Uses the logged-in user's API key if set, else the global one. */
function authHeaderForReq(req: Request): string {
  const session = getSession(req);
  if (session) {
    const userKey = USER_KEYS.get(session.username);
    if (userKey) return `Basic ${btoa(`${userKey}:X`)}`;
  }
  return AUTH_HEADER;
}

// ── Freshdesk API helper ─────────────────────────────────────────────────────

async function fdApi<T>(method: string, path: string, body?: unknown, auth?: string, retries = 0): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Authorization: auth || AUTH_HEADER },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);

  if (resp.status === 429) {
    if (retries >= MAX_RETRIES) throw new Error(`Rate limited after ${MAX_RETRIES} retries: ${method} ${path}`);
    const retryAfter = parseInt(resp.headers.get("retry-after") || "30", 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return fdApi(method, path, body, auth, retries + 1);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${method} ${path}: ${resp.status} ${text}`);
  }

  const text = await resp.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

/** Bounded concurrency executor */
async function parallel<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ── Agent lookup (for ticket reassignment) ──────────────────────────────────

let cachedAmarAgentId: number | null = null;

async function getAmarAgentId(): Promise<number> {
  if (cachedAmarAgentId) return cachedAmarAgentId;
  const agents = await fdApi<{ id: number; contact: { email: string } }[]>(
    "GET",
    `/api/v2/agents?email=amar@swarajyamag.com`
  );
  if (!agents.length) throw new Error("Agent amar@swarajyamag.com not found in Freshdesk");
  cachedAmarAgentId = agents[0].id;
  return cachedAmarAgentId;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface TicketListItem {
  id: number;
  subject: string;
  status: number;
  priority: number;
  source: number;
  to_emails: string[];
  cc_emails: string[];
  tags: string[];
  requester_id: number;
  created_at: string;
  group_id: number | null;
  description_text?: string;
  requester?: { id: number; name: string; email: string };
  attachments?: { name: string; attachment_url: string; size: number }[];
}

interface TriageTicket {
  id: number;
  subject: string;
  from_email: string;
  from_name: string;
  to_emails: string[];
  cc_emails: string[];
  excerpt: string;            // 200-char snippet sent to Claude for triage
  description_text: string;   // full original message shown in the UI
  tags: string[];
  created_at: string;
}

type ActionType = "escalate_both" | "escalate_amar" | "forward_drafts" | "close" | "leave";

interface TriageResult {
  id: number;
  action: ActionType;
  rule: string;
  reason: string;
}

interface TriageAction {
  id: number;
  action: ActionType;
  tags?: string[];
}

interface ActionResult {
  id: number;
  action: string;
  status: "OK" | "FAIL" | "SKIP";
  detail: string;
}

interface FdAttachment {
  id?: number;
  name: string;
  content_type?: string;
  size: number;
  attachment_url: string;
}

interface FdConversation {
  id: number;
  body_text?: string;
  body?: string;
  incoming: boolean;
  private: boolean;
  user_id: number;
  from_email?: string;
  to_emails?: string[];
  created_at: string;
  attachments?: FdAttachment[];
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleLogin(req: Request): Promise<Response> {
  try {
    const { username, password } = (await req.json()) as { username: string; password: string };
    const user = username?.trim().toLowerCase();
    const storedPass = USERS.get(user);
    if (!storedPass || storedPass !== password) {
      return Response.json({ error: "Invalid username or password" }, { status: 401 });
    }
    const token = createSession(user);
    return new Response(JSON.stringify({ ok: true, username: user }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": `session=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=86400`,
      },
    });
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
}

async function handleFetchTickets(req: Request): Promise<Response> {
  if (!validSession(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const auth = authHeaderForReq(req);

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const perPage = 50;

  try {
    const tickets = await fdApi<TicketListItem[]>(
      "GET",
      `/api/v2/tickets?per_page=${perPage}&page=${page}&order_by=created_at&order_type=desc&include=requester,description`,
      undefined,
      auth
    );

    const unchecked = tickets.filter((t) => t.status === 2 && !t.tags.includes("Checked"));

    const triageTickets: TriageTicket[] = unchecked.map((ticket) => {
      const descText = (ticket.description_text || "")
        .replace(/\[image:[^\]]*\]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const excerpt = descText.slice(0, 200).replace(/[\r\n]+/g, " ").trim();
      return {
        id: ticket.id,
        subject: ticket.subject,
        from_email: ticket.requester?.email || "unknown",
        from_name: ticket.requester?.name || "",
        to_emails: ticket.to_emails,
        cc_emails: ticket.cc_emails,
        excerpt,
        description_text: descText,
        tags: ticket.tags,
        created_at: ticket.created_at,
      };
    });

    const hasMore = tickets.length === perPage;

    return Response.json({
      page,
      per_page: perPage,
      fetched: tickets.length,
      open_on_page: tickets.filter((t) => t.status === 2).length,
      unchecked: triageTickets.length,
      has_more: hasMore,
      tickets: triageTickets,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function handleTriage(req: Request): Promise<Response> {
  if (!validSession(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { tickets } = (await req.json()) as { tickets: TriageTicket[] };
    if (!tickets || !tickets.length) {
      return Response.json({ error: "No tickets provided" }, { status: 400 });
    }

    // Batch into groups of 30
    const batches: TriageTicket[][] = [];
    for (let i = 0; i < tickets.length; i += 30) {
      batches.push(tickets.slice(i, i + 30));
    }

    const allResults: TriageResult[] = [];

    for (const batch of batches) {
      const ticketData = batch.map((t) => ({
        id: t.id,
        subject: t.subject,
        from_email: t.from_email,
        from_name: t.from_name,
        to_emails: t.to_emails,
        excerpt: t.excerpt,
      }));

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL_TRIAGE,
          max_tokens: 4096,
          system: TRIAGE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Classify these tickets:\n\n${JSON.stringify(ticketData, null, 2)}`,
            },
          ],
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Anthropic API: ${resp.status} ${errText}`);
      }

      const data = (await resp.json()) as { content: { type: string; text: string }[] };
      const text = data.content.find((c) => c.type === "text")?.text || "[]";

      // Extract JSON from response (might be wrapped in markdown code block)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("Claude returned no JSON array");

      const results: TriageResult[] = JSON.parse(jsonMatch[0]);
      allResults.push(...results);
    }

    return Response.json({ results: allResults });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function handleExecute(req: Request): Promise<Response> {
  if (!validSession(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const auth = authHeaderForReq(req);

  try {
    const { actions } = (await req.json()) as { actions: TriageAction[] };
    if (!actions || !actions.length) {
      return Response.json({ error: "No actions provided" }, { status: 400 });
    }

    const results = await parallel(actions, CONCURRENCY, async ({ id, action, tags }): Promise<ActionResult> => {
      try {
        if (action === "leave") {
          return { id, action, status: "SKIP", detail: "Left for human review" };
        }

        if (action === "escalate_both" || action === "escalate_amar") {
          const ticket = await fdApi<TicketListItem>("GET", `/api/v2/tickets/${id}`, undefined, auth);
          const existingTags = tags || ticket.tags || [];
          const newTags = existingTags.includes("Checked") ? existingTags : [...existingTags, "Checked"];

          const subject = ticket.subject || "";
          const rawDescription = ticket.description_text || "(no content)";
          // Clean the description: strip excessive whitespace and truncate
          const cleanDescription = rawDescription
            .replace(/\[image:[^\]]*\]/g, "") // Remove [image: ...] placeholders
            .replace(/\n{3,}/g, "\n\n") // Collapse multiple newlines
            .replace(/^[\s>*-]+$/gm, "") // Remove lines that are just whitespace/quotes/bullets
            .replace(/\n{3,}/g, "\n\n") // Collapse again after cleanup
            .trim()
            .slice(0, 1500); // Truncate to reasonable length

          const ticketUrl = `${BASE_URL}/a/tickets/${id}`;
          const requesterEmail = ticket.requester?.email || "unknown";
          const requesterName = ticket.requester?.name || "";
          const fromLine = requesterName ? `${requesterName} <${requesterEmail}>` : requesterEmail;

          const forwardBody = `This ticket has been forwarded for review.

Ticket URL: ${ticketUrl}
From: ${fromLine}
Subject: ${subject}

--- Original Message ---

${cleanDescription}`;

          const notifyEmails =
            action === "escalate_both"
              ? ["amar@swarajyamag.com", "raghu@swarajyamag.com"]
              : ["amar@swarajyamag.com"];

          // Use notes endpoint with notify_emails to forward (not reply to sender)
          await fdApi("POST", `/api/v2/tickets/${id}/notes`, {
            body: forwardBody,
            private: false,
            notify_emails: notifyEmails,
          }, auth);
          await fdApi("PUT", `/api/v2/tickets/${id}`, { tags: newTags }, auth);
          return { id, action, status: "OK", detail: "Forwarded + tagged" };
        } else if (action === "forward_drafts") {
          const ticket = await fdApi<TicketListItem>("GET", `/api/v2/tickets/${id}`, undefined, auth);
          const existingTags = tags || ticket.tags || [];
          const newTags = existingTags.includes("Checked") ? existingTags : [...existingTags, "Checked"];

          const subject = ticket.subject || "";
          const rawDescription = ticket.description_text || "(no content)";
          const cleanDescription = rawDescription
            .replace(/\[image:[^\]]*\]/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/^[\s>*-]+$/gm, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim()
            .slice(0, 3000);

          const requesterEmail = ticket.requester?.email || "unknown";
          const requesterName = ticket.requester?.name || "";
          const fromLine = requesterName ? `${requesterName} <${requesterEmail}>` : requesterEmail;
          const ticketUrl = `${BASE_URL}/a/tickets/${id}`;

          // List attachments if any
          const attachments = ticket.attachments || [];
          const attachmentLines = attachments.length
            ? "\n\nAttachments:\n" + attachments.map((a) => `- ${a.name} (${Math.round(a.size / 1024)}KB): ${a.attachment_url}`).join("\n")
            : "";

          const forwardBody = `Article draft submitted for publication.

From: ${fromLine}
Subject: ${subject}
Ticket: ${ticketUrl}${attachmentLines}

--- Draft Content ---

${cleanDescription}`;

          await fdApi("POST", `/api/v2/tickets/${id}/notes`, {
            body: forwardBody,
            private: true,
            notify_emails: ["amar@swarajyamag.com"],
          }, auth);
          // Send acknowledgment reply to the original requester
          await fdApi("POST", `/api/v2/tickets/${id}/reply`, {
            body: "Thank you for sending your draft. We receive dozens of emails every day and will try to get back to you as soon as we can. In case we do not come back, it may be understood that we may not be able to publish your draft at this time. Nevertheless, do be rest assured that all drafts do get seen by an editorial team member.\n\nThis ticket may be closed as part of our workflow. Do write back to us in case you want to communicate anything else further.",
          }, auth);
          // Reassign ticket to amar instead of closing
          const amarAgentId = await getAmarAgentId();
          await fdApi("PUT", `/api/v2/tickets/${id}`, { tags: newTags, responder_id: amarAgentId }, auth);
          return { id, action, status: "OK", detail: "Forwarded to amar@ + replied to requester + reassigned" };
        } else if (action === "close") {
          let existingTags: string[];
          if (tags) {
            existingTags = tags;
          } else {
            const ticket = await fdApi<TicketListItem>("GET", `/api/v2/tickets/${id}`, undefined, auth);
            existingTags = ticket.tags || [];
          }
          const newTags = existingTags.includes("Checked") ? existingTags : [...existingTags, "Checked"];

          await fdApi("PUT", `/api/v2/tickets/${id}`, { tags: newTags, status: 5 }, auth);
          return { id, action, status: "OK", detail: "Tagged + closed" };
        } else {
          return { id, action, status: "FAIL", detail: `Unknown action: ${action}` };
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { id, action, status: "FAIL", detail: msg };
      }
    });

    return Response.json({ results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function buildDraftFromClaude(
  ticket: TicketListItem,
  conversations: FdConversation[],
  instructions?: string
): Promise<{ draft: string; images_considered: number; images_total: number }> {
  const requesterName = ticket.requester?.name || "";
  const requesterEmail = ticket.requester?.email || "unknown";
  const fromLine = requesterName ? `${requesterName} <${requesterEmail}>` : requesterEmail;

  const cleanText = (s: string) =>
    s.replace(/\[image:[^\]]*\]/g, "").replace(/\n{3,}/g, "\n\n").trim();

  const messages: string[] = [];
  messages.push(
    `--- Original message | ${ticket.created_at} ---\nFrom: ${fromLine}\nSubject: ${ticket.subject}\n\n${cleanText(ticket.description_text || "")}`
  );
  for (const c of conversations || []) {
    const dir = c.incoming ? "Incoming (customer)" : "Outgoing (agent)";
    const vis = c.private ? " [private note]" : "";
    const text = cleanText(c.body_text || c.body || "");
    messages.push(`--- ${dir}${vis} | ${c.created_at} ---\n${text}`);
  }

  const allAttachments: FdAttachment[] = [
    ...(ticket.attachments || []),
    ...((conversations || []).flatMap((c) => c.attachments || [])),
  ];
  const imageExtRe = /\.(png|jpe?g|gif|webp)$/i;
  const imageAttachments = allAttachments.filter((a) => {
    if (a.content_type?.startsWith("image/")) return true;
    return imageExtRe.test(a.name);
  });

  const MAX_IMAGES = 10;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const imageBlocks: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];
  const imageNotes: string[] = [];

  for (const att of imageAttachments.slice(0, MAX_IMAGES)) {
    if (att.size > MAX_IMAGE_BYTES) {
      imageNotes.push(`(skipped ${att.name}: ${Math.round(att.size / 1024 / 1024)}MB > 5MB)`);
      continue;
    }
    try {
      const imgResp = await fetch(att.attachment_url);
      if (!imgResp.ok) {
        imageNotes.push(`(failed to fetch ${att.name}: HTTP ${imgResp.status})`);
        continue;
      }
      const buf = await imgResp.arrayBuffer();
      const base64 = Buffer.from(buf).toString("base64");
      let mediaType = att.content_type;
      if (!mediaType?.startsWith("image/")) {
        const ext = att.name.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
        mediaType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      }
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: base64 },
      });
      imageNotes.push(`(${att.name}, ${Math.round(att.size / 1024)}KB)`);
    } catch (e) {
      imageNotes.push(`(error fetching ${att.name})`);
    }
  }
  if (imageAttachments.length > MAX_IMAGES) {
    imageNotes.push(`(${imageAttachments.length - MAX_IMAGES} more images not sent)`);
  }

  const attachmentLine = imageBlocks.length
    ? `\n\nThe customer attached ${imageBlocks.length} image(s) — included below. Refer to them when relevant: ${imageNotes.join(", ")}`
    : "";

  const instructionsBlock = instructions?.trim()
    ? `\n\n--- Specific instructions from the agent for THIS draft ---\n${instructions.trim()}\n\nApply these instructions while still following the response guidelines. If they conflict with the guidelines, prefer the agent's instructions for tone/content but keep policy/factual constraints from the guidelines.`
    : "";

  const userMsg = `You are drafting a reply on behalf of a Swarajya / Kovai Media support agent to the following customer ticket. Follow the response guidelines strictly. Reply with ONLY the body of the email — no greeting hacks, no JSON, no markdown fences, no commentary. The agent will review and send it as-is.

Ticket #${ticket.id}
Customer: ${fromLine}
Subject: ${ticket.subject}

Full thread (chronological, oldest first):

${messages.join("\n\n")}${attachmentLine}${instructionsBlock}`;

  const userContent: unknown[] = [{ type: "text", text: userMsg }, ...imageBlocks];

  const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL_DRAFT_REPLY,
      max_tokens: 2048,
      system: [{ type: "text", text: RESPONSE_GUIDELINES, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!anthropicResp.ok) {
    const errText = await anthropicResp.text();
    throw new Error(`Anthropic API: ${anthropicResp.status} ${errText}`);
  }

  const data = (await anthropicResp.json()) as { content: { type: string; text: string }[] };
  const draft = data.content.find((c) => c.type === "text")?.text || "";
  return { draft, images_considered: imageBlocks.length, images_total: imageAttachments.length };
}

async function handleTicketThread(req: Request): Promise<Response> {
  if (!validSession(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const auth = authHeaderForReq(req);

  try {
    const url = new URL(req.url);
    const ticketIdRaw = url.searchParams.get("id");
    if (!ticketIdRaw) return Response.json({ error: "Missing id" }, { status: 400 });
    const ticket_id = parseInt(ticketIdRaw, 10);
    if (!ticket_id) return Response.json({ error: "Invalid id" }, { status: 400 });

    const [ticket, conversations] = await Promise.all([
      fdApi<TicketListItem>("GET", `/api/v2/tickets/${ticket_id}?include=requester`, undefined, auth),
      fdApi<FdConversation[]>("GET", `/api/v2/tickets/${ticket_id}/conversations`, undefined, auth),
    ]);

    const requesterName = ticket.requester?.name || "";
    const requesterEmail = ticket.requester?.email || "unknown";

    const messages = [
      {
        type: "original",
        from: requesterName ? `${requesterName} <${requesterEmail}>` : requesterEmail,
        body_text: ticket.description_text || "",
        created_at: ticket.created_at,
        incoming: true,
        private: false,
        attachments: (ticket.attachments || []).map((a) => ({
          name: a.name,
          size: a.size,
          url: a.attachment_url,
          content_type: a.content_type,
        })),
      },
      ...(conversations || []).map((c) => ({
        type: c.incoming ? "incoming" : "outgoing",
        from: c.from_email || (c.incoming ? requesterEmail : "agent"),
        body_text: c.body_text || c.body || "",
        created_at: c.created_at,
        incoming: c.incoming,
        private: c.private,
        attachments: (c.attachments || []).map((a) => ({
          name: a.name,
          size: a.size,
          url: a.attachment_url,
          content_type: a.content_type,
        })),
      })),
    ];

    return Response.json({
      ticket_id,
      subject: ticket.subject,
      requester: { name: requesterName, email: requesterEmail },
      messages,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function handleDraftReply(req: Request): Promise<Response> {
  if (!validSession(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const auth = authHeaderForReq(req);

  try {
    const { ticket_id, instructions } = (await req.json()) as { ticket_id: number; instructions?: string };
    if (!ticket_id) return Response.json({ error: "Missing ticket_id" }, { status: 400 });

    const [ticket, conversations] = await Promise.all([
      fdApi<TicketListItem>("GET", `/api/v2/tickets/${ticket_id}?include=requester`, undefined, auth),
      fdApi<FdConversation[]>("GET", `/api/v2/tickets/${ticket_id}/conversations`, undefined, auth),
    ]);

    const result = await buildDraftFromClaude(ticket, conversations, instructions);
    return Response.json({ ...result, subject: ticket.subject });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

const DRAFT_NOTE_PREFIX = "🤖 Suggested reply (Claude AI — review and edit before sending):\n\n";
const DRAFT_POSTED_TAG = "DraftPosted";

async function handleDraftLeaveOne(req: Request): Promise<Response> {
  if (!validSession(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const auth = authHeaderForReq(req);

  try {
    const { ticket_id } = (await req.json()) as { ticket_id: number };
    if (!ticket_id) return Response.json({ error: "Missing ticket_id" }, { status: 400 });

    const [ticket, conversations] = await Promise.all([
      fdApi<TicketListItem>("GET", `/api/v2/tickets/${ticket_id}?include=requester`, undefined, auth),
      fdApi<FdConversation[]>("GET", `/api/v2/tickets/${ticket_id}/conversations`, undefined, auth),
    ]);

    // Already drafted? Check if there's a newer customer message.
    if ((ticket.tags || []).includes(DRAFT_POSTED_TAG)) {
      const ourNotes = (conversations || []).filter((c) => !c.incoming && c.private);
      if (ourNotes.length > 0) {
        const latestNoteAt = Math.max(...ourNotes.map((n) => new Date(n.created_at).getTime()));
        const hasFollowUp = (conversations || []).some(
          (c) => c.incoming && new Date(c.created_at).getTime() > latestNoteAt
        );
        if (!hasFollowUp) {
          return Response.json({
            ticket_id,
            status: "SKIP",
            detail: "Already drafted, no new customer message",
          });
        }
      }
    }

    const { draft, images_considered, images_total } = await buildDraftFromClaude(ticket, conversations);

    const fdForm = new FormData();
    fdForm.append("body", DRAFT_NOTE_PREFIX + draft);
    fdForm.append("private", "true");
    const noteResp = await fetch(`${BASE_URL}/api/v2/tickets/${ticket_id}/notes`, {
      method: "POST",
      headers: { Authorization: auth },
      body: fdForm,
    });
    if (!noteResp.ok) {
      const errText = await noteResp.text();
      throw new Error(`Note post: ${noteResp.status} ${errText}`);
    }

    const newTags = Array.from(new Set([...(ticket.tags || []), DRAFT_POSTED_TAG]));
    await fdApi("PUT", `/api/v2/tickets/${ticket_id}`, { tags: newTags }, auth);

    return Response.json({
      ticket_id,
      status: "OK",
      detail: `Draft posted${images_considered ? ` (with ${images_considered} image${images_considered === 1 ? "" : "s"})` : ""} + tagged`,
      images_considered,
      images_total,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function handleSendReply(req: Request): Promise<Response> {
  if (!validSession(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const auth = authHeaderForReq(req);

  try {
    const form = await req.formData();
    const ticketIdRaw = form.get("ticket_id");
    const kind = form.get("kind");
    const body = form.get("body");

    if (!ticketIdRaw || !kind || !body) {
      return Response.json({ error: "Missing ticket_id, kind, or body" }, { status: 400 });
    }
    if (kind !== "reply" && kind !== "note") {
      return Response.json({ error: "kind must be 'reply' or 'note'" }, { status: 400 });
    }

    const ticketId = String(ticketIdRaw);
    const attachments = form.getAll("attachments").filter((a): a is File => a instanceof File && a.size > 0);

    const path =
      kind === "reply" ? `/api/v2/tickets/${ticketId}/reply` : `/api/v2/tickets/${ticketId}/notes`;

    const fdForm = new FormData();
    fdForm.append("body", String(body));
    if (kind === "note") fdForm.append("private", "true");
    for (const file of attachments) {
      fdForm.append("attachments[]", file, file.name);
    }

    const fdResp = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { Authorization: auth },
      body: fdForm,
    });

    if (!fdResp.ok) {
      const errText = await fdResp.text();
      throw new Error(`Freshdesk ${path}: ${fdResp.status} ${errText}`);
    }

    return Response.json({ ok: true, kind, attachments: attachments.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// ── Daily review (cron-triggered, posts digest to Google Chat) ───────────────

const FORWARD_DRAFTS_AUTO_REPLY_PREFIX = "Thank you for sending your draft. We receive dozens of emails";

type CustomerState = "satisfied" | "neutral" | "dissatisfied" | "angry";
type ServiceQuality = "ok" | "unsatisfactory" | "no_agent_reply";

interface ReplyGrade {
  customer_state: CustomerState;
  service_quality: ServiceQuality;
  flagged: boolean;
  reason: string;
}

interface GradeCandidate {
  ticket: TicketListItem;
  conversations: FdConversation[];
  replyBody: string;
}

interface CachedGrade {
  grade: ReplyGrade;
  latest_activity_at: string;   // ISO — timestamp of latest message (any direction) when graded
  graded_at: string;
  // legacy field, kept only to help migrate old cache entries without discarding them
  latest_customer_msg_at?: string;
}

/**
 * Fingerprint the ticket's conversation state so we can tell whether anything
 * new has arrived since we last graded. Tracks the latest timestamp across
 * ALL messages (incoming or outgoing) — an agent reply after a "no_agent_reply"
 * grade must invalidate the cache, not just new customer messages.
 */
function latestActivityAt(conversations: FdConversation[]): string {
  const list = conversations || [];
  if (!list.length) return "1970-01-01T00:00:00Z";
  return list
    .map((c) => c.created_at)
    .sort()
    .slice(-1)[0];
}

async function loadGradeCache(): Promise<Record<string, CachedGrade>> {
  const f = Bun.file(GRADE_CACHE_PATH);
  if (!(await f.exists())) return {};
  try {
    return (await f.json()) as Record<string, CachedGrade>;
  } catch {
    return {};
  }
}

async function saveGradeCache(cache: Record<string, CachedGrade>): Promise<void> {
  await Bun.write(GRADE_CACHE_PATH, JSON.stringify(cache, null, 2));
}

/**
 * Grade N tickets in ONE Claude call. Returns grades in input order.
 * With prompt caching on RESPONSE_GUIDELINES, the ~7K-token system prompt
 * costs full price on the first batch and ~10% on every batch after.
 */
async function gradeAgentRepliesBatch(candidates: GradeCandidate[]): Promise<ReplyGrade[]> {
  if (!candidates.length) return [];

  const cleanText = (s: string) =>
    s.replace(/\[image:[^\]]*\]/g, "").replace(/\n{3,}/g, "\n\n").trim();

  const buildTicketSection = (c: GradeCandidate, idx: number): string => {
    const { ticket, conversations, replyBody } = c;
    const requesterName = ticket.requester?.name || "";
    const requesterEmail = ticket.requester?.email || "unknown";
    const fromLine = requesterName ? `${requesterName} <${requesterEmail}>` : requesterEmail;

    const lines: string[] = [];
    lines.push(`--- Original | ${ticket.created_at} ---\nFrom: ${fromLine}\nSubject: ${ticket.subject}\n\n${cleanText(ticket.description_text || "")}`);
    for (const c2 of conversations || []) {
      const dir = c2.incoming ? "Incoming (customer)" : "Outgoing (agent)";
      const vis = c2.private ? " [private note]" : "";
      lines.push(`--- ${dir}${vis} | ${c2.created_at} ---\n${cleanText(c2.body_text || c2.body || "")}`);
    }
    const replyClause = replyBody
      ? `The most recent agent reply (last 24h):\n"""\n${replyBody}\n"""`
      : `(No agent reply yet — the customer is waiting.)`;

    return `====== TICKET ${idx + 1} of ${candidates.length} (ID: ${ticket.id}) ======
Subject: ${ticket.subject}
Customer: ${fromLine}

Full thread:
${lines.join("\n\n")}

${replyClause}`;
  };

  const ticketSections = candidates.map(buildTicketSection).join("\n\n");

  const userMsg = `You are screening ${candidates.length} Swarajya / Kovai Media support tickets for the editor. Flag ONLY tickets where EITHER (a) the customer expresses anger or dissatisfaction, OR (b) the most recent service response was unsatisfactory. Ignore style/tone nits — the goal is real customer-experience problems.

For EACH ticket in the list below, output ONE JSON object on its own line, IN THE SAME ORDER as the tickets appear. Do not include any other text, markdown, or preamble.

Each JSON object must have exactly these keys:
{"ticket_index": <1-based index>, "customer_state": "satisfied" | "neutral" | "dissatisfied" | "angry", "service_quality": "ok" | "unsatisfactory" | "no_agent_reply", "flagged": true | false, "reason": "1-2 sentences (only meaningful when flagged=true)"}

Field meanings:

customer_state — read the customer's MOST RECENT message on that ticket:
- "angry": clear hostility, threats, demands, all-caps, accusations, escalation threats ("this is unacceptable", "I'll go to consumer court", "refund NOW", repeated complaints)
- "dissatisfied": frustration, disappointment, complaint about delays/wrong items/unmet expectations — not yet hostile
- "neutral": normal enquiry, polite question, status check
- "satisfied": expressing thanks, confirming resolution, positive feedback

service_quality — judge the most recent agent reply on that ticket:
- "no_agent_reply": customer has written but no agent has replied yet in the window
- "unsatisfactory": agent ignored the main question, was dismissive/rude, gave a generic answer when specifics were needed, was factually wrong, contradicted policy, dropped the ticket without resolution, demanded info already provided, or made the situation worse. IGNORE style/tone nits like "Jai Hind", stacked apologies, formatting — those are NOT unsatisfactory service. Service is unsatisfactory only when the CUSTOMER would reasonably be unhappy with what they got.
- "ok": agent addressed the customer's question with reasonable care.

flagged — true if customer_state is "dissatisfied"/"angry" OR service_quality is "unsatisfactory". Otherwise false.

Be honest. If nothing's wrong, flagged=false. If ambiguous, default to not flagged.

TICKETS:

${ticketSections}

REMEMBER: output exactly ${candidates.length} JSON objects, one per line, in order.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL_GRADE,
      max_tokens: Math.max(512, candidates.length * 200),
      system: [{ type: "text", text: RESPONSE_GUIDELINES, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  const fallbackGrade: ReplyGrade = { customer_state: "neutral", service_quality: "ok", flagged: false, reason: "Grader call failed" };
  if (!resp.ok) {
    console.error(`[grader] API ${resp.status}: ${await resp.text()}`);
    return candidates.map(() => fallbackGrade);
  }

  const data = (await resp.json()) as { content: { type: string; text: string }[]; usage?: Record<string, unknown> };
  if (data.usage) {
    const write = data.usage.cache_creation_input_tokens ?? 0;
    const read = data.usage.cache_read_input_tokens ?? 0;
    const uncached = data.usage.input_tokens ?? 0;
    console.log(`[grader] batch=${candidates.length}  cache write=${write}  read=${read}  uncached=${uncached}`);
  }
  const text = data.content.find((c) => c.type === "text")?.text || "";

  // Parse N JSON objects (one per line). Robust to code fences and stray text.
  const parsed: Array<Partial<ReplyGrade> & { ticket_index?: number }> = [];
  const objRegex = /\{[^{}]*"customer_state"[^{}]*\}/g;
  const matches = text.match(objRegex) || [];
  for (const m of matches) {
    try {
      parsed.push(JSON.parse(m));
    } catch {
      // skip malformed
    }
  }

  // Map by ticket_index (1-based) if provided; otherwise by parse order.
  const grades: ReplyGrade[] = candidates.map((_c, i) => {
    const byIndex = parsed.find((p) => p.ticket_index === i + 1);
    const p = byIndex || parsed[i];
    if (!p) return { ...fallbackGrade, reason: "No grade returned for this ticket" };
    const cs = p.customer_state;
    const sq = p.service_quality;
    const customer_state: CustomerState =
      cs === "angry" || cs === "dissatisfied" || cs === "satisfied" || cs === "neutral" ? cs : "neutral";
    const service_quality: ServiceQuality =
      sq === "unsatisfactory" || sq === "no_agent_reply" || sq === "ok" ? sq : "ok";
    const flagged =
      customer_state === "angry" ||
      customer_state === "dissatisfied" ||
      service_quality === "unsatisfactory";
    return {
      customer_state,
      service_quality,
      flagged,
      reason: p.reason || "(no reason given)",
    };
  });

  return grades;
}

async function summarisePatterns(flaggedCases: Array<{ ticket_id: number; reason: string; customer_state: CustomerState; service_quality: ServiceQuality }>): Promise<string> {
  if (!flaggedCases.length) return "";

  const list = flaggedCases.map((c, i) =>
    `${i + 1}. Ticket #${c.ticket_id} [customer: ${c.customer_state}, service: ${c.service_quality}]: ${c.reason}`
  ).join("\n");

  const userMsg = `These are the Swarajya / Kovai Media helpdesk tickets flagged today as needing the editor's attention — either the customer was angry/dissatisfied, or the AI judged the service unsatisfactory:

${list}

In 3-4 sentences total, write an opening summary for the editor's daily digest:
- What's the most painful pattern across these tickets? (Recurring complaint types like missing magazines, refund delays, broken renewals; OR recurring service failures like ignored questions, generic replies, dropped tickets.)
- Distinguish between "customer is upset" and "agent did badly" if relevant.
- End with ONE concrete coaching or process takeaway for tomorrow.

Output ONLY the 3-4 sentence summary as plain text. No markdown headers, no bullets, no preamble like "Here's the summary".`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL_NARRATIVE,
        max_tokens: 400,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!resp.ok) return "";
    const data = (await resp.json()) as { content: { type: string; text: string }[] };
    return (data.content.find((c) => c.type === "text")?.text || "").trim();
  } catch {
    return "";
  }
}

async function handleDailyReview(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const providedSecret = url.searchParams.get("secret") || req.headers.get("x-cron-secret") || "";
  if (!CRON_SECRET || providedSecret !== CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hoursStr = url.searchParams.get("hours");
  const hours = hoursStr ? Math.max(1, Math.min(168, parseInt(hoursStr, 10))) : 24;
  const dryRun = url.searchParams.get("dry") === "1";

  // Dry-run path waits for completion and returns the full result (used for terminal debugging).
  // Live path returns 200 immediately and runs the review in the background — so callers like
  // the Railway cron service get a fast response and don't retry on timeout.
  if (!dryRun) {
    runDailyReview(hours, false).catch((err) => {
      console.error("[daily-review background error]", err instanceof Error ? err.message : String(err));
    });
    return Response.json({
      status: "started",
      message: "Daily review running in background. Digest will be posted to Google Chat when complete.",
      period_hours: hours,
      started_at: new Date().toISOString(),
    });
  }

  // Dry-run: process synchronously, return full digest payload.
  try {
    const result = await runDailyReview(hours, true);
    return Response.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function runDailyReview(hours: number, dryRun: boolean): Promise<Record<string, unknown>> {
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  try {

    // Fetch tickets updated since (use Freshdesk's filter)
    const allTickets: TicketListItem[] = [];
    let page = 1;
    while (page <= 10) {
      const batch = await fdApi<TicketListItem[]>(
        "GET",
        `/api/v2/tickets?updated_since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}&order_by=updated_at&order_type=desc&include=requester,description`
      );
      if (!batch.length) break;
      allTickets.push(...batch);
      if (batch.length < 100) break;
      page++;
    }

    // For each ticket, gather its conversation. Include EVERY ticket touched in the window,
    // even those without any agent reply yet — the grader detects angry customers waiting too.
    interface Candidate { ticket: TicketListItem; conversations: FdConversation[]; replyBody: string }
    const candidates: Candidate[] = [];

    await parallel(allTickets, 5, async (ticket) => {
      try {
        const convs = await fdApi<FdConversation[]>("GET", `/api/v2/tickets/${ticket.id}/conversations`);
        // Find latest outgoing public reply in window, excluding forward_drafts boilerplate.
        // If none, replyBody = "" — grader treats that as no_agent_reply.
        const replies = (convs || [])
          .filter((c) => !c.incoming && !c.private)
          .filter((c) => new Date(c.created_at).getTime() >= sinceMs);
        const human = replies.filter((c) => {
          const body = (c.body_text || c.body || "").trim();
          return body && !body.startsWith(FORWARD_DRAFTS_AUTO_REPLY_PREFIX);
        });
        let replyBody = "";
        if (human.length) {
          human.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
          replyBody = (human[0].body_text || human[0].body || "").trim();
        }
        candidates.push({ ticket, conversations: convs, replyBody });
      } catch {
        // skip per-ticket fetch error
      }
    });

    // Grade candidates using cache + batched grader.
    // Cache hit if a ticket was graded before AND no new customer message since.
    interface Graded { ticket: TicketListItem; grade: ReplyGrade }
    const graded: Graded[] = [];
    const cache = await loadGradeCache();

    const toGrade: GradeCandidate[] = [];
    let cacheHits = 0;
    for (const c of candidates) {
      const key = String(c.ticket.id);
      const currentActivity = latestActivityAt(c.conversations);
      const cached = cache[key];
      // Cache hit only when the latest message across ALL directions matches.
      // (Old entries stored latest_customer_msg_at only — we can't safely reuse
      // them because they wouldn't have registered a new agent reply. Fall
      // through to re-grade; the next write updates the entry to the new shape.)
      if (cached && cached.latest_activity_at === currentActivity) {
        graded.push({ ticket: c.ticket, grade: cached.grade });
        cacheHits++;
      } else {
        toGrade.push(c);
      }
    }
    console.log(`[grader] cache hits: ${cacheHits}/${candidates.length}  ·  to grade: ${toGrade.length}`);

    // Batch grade the remainder (concurrency of batches, not individual tickets)
    const batches: GradeCandidate[][] = [];
    for (let i = 0; i < toGrade.length; i += GRADE_BATCH_SIZE) {
      batches.push(toGrade.slice(i, i + GRADE_BATCH_SIZE));
    }
    await parallel(batches, 3, async (batch) => {
      try {
        const grades = await gradeAgentRepliesBatch(batch);
        for (let i = 0; i < batch.length; i++) {
          const c = batch[i];
          const g = grades[i];
          graded.push({ ticket: c.ticket, grade: g });
          cache[String(c.ticket.id)] = {
            grade: g,
            latest_activity_at: latestActivityAt(c.conversations),
            graded_at: new Date().toISOString(),
          };
        }
      } catch (e) {
        console.error(`[grader] batch failed: ${e instanceof Error ? e.message : e}`);
      }
    });

    // Persist cache (best effort — swallow failures so review still completes)
    try {
      await saveGradeCache(cache);
    } catch (e) {
      console.error(`[grader] cache save failed: ${e instanceof Error ? e.message : e}`);
    }

    // Only flagged tickets make the report.
    const flagged = graded.filter((g) => g.grade.flagged);

    // Subcategories for the digest grouping
    const angry = flagged.filter((g) => g.grade.customer_state === "angry");
    const dissatisfied = flagged.filter((g) => g.grade.customer_state === "dissatisfied");
    const happyButBadService = flagged.filter((g) =>
      (g.grade.customer_state === "neutral" || g.grade.customer_state === "satisfied") &&
      g.grade.service_quality === "unsatisfactory"
    );

    // Meta-narrative — only if there's something flagged
    let summary = "";
    if (flagged.length > 0) {
      summary = await summarisePatterns(flagged.map((g) => ({
        ticket_id: g.ticket.id,
        reason: g.grade.reason,
        customer_state: g.grade.customer_state,
        service_quality: g.grade.service_quality,
      })));
    }

    const periodLabel = hours === 24 ? "last 24h" : `last ${hours}h`;

    // Plain-text digest (kept for dry-run inspection)
    let digest = `*Helpdesk daily review* — ${periodLabel}\n`;
    digest += `Tickets reviewed: ${graded.length}  ·  Flagged: ${flagged.length}\n\n`;
    if (summary) digest += `${summary}\n\n`;
    if (angry.length > 0) {
      digest += `*🔥 Angry customers (${angry.length}):*\n`;
      for (const g of angry) {
        digest += `• <${BASE_URL}/a/tickets/${g.ticket.id}|#${g.ticket.id}> — ${g.grade.reason}\n`;
      }
      digest += "\n";
    }
    if (dissatisfied.length > 0) {
      digest += `*😟 Dissatisfied customers (${dissatisfied.length}):*\n`;
      for (const g of dissatisfied) {
        digest += `• <${BASE_URL}/a/tickets/${g.ticket.id}|#${g.ticket.id}> — ${g.grade.reason}\n`;
      }
      digest += "\n";
    }
    if (happyButBadService.length > 0) {
      digest += `*⚠️ Service issues (customer hasn't complained, but service was unsatisfactory) (${happyButBadService.length}):*\n`;
      for (const g of happyButBadService) {
        digest += `• <${BASE_URL}/a/tickets/${g.ticket.id}|#${g.ticket.id}> — ${g.grade.reason}\n`;
      }
    }
    if (flagged.length === 0) {
      digest += `*✅ Nothing to flag.* No angry/dissatisfied customers, no unsatisfactory service.`;
    }

    // Rich Chat card
    const escHtmlForCard = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const sections: unknown[] = [];

    if (flagged.length > 0 && summary) {
      sections.push({
        widgets: [{ textParagraph: { text: `<b>Pattern observed</b><br>${escHtmlForCard(summary)}` } }],
      });
    }

    const renderGroup = (header: string, items: Graded[]) => {
      if (!items.length) return;
      const widgets: unknown[] = [];
      const MAX_LIST = 25;
      const shown = items.slice(0, MAX_LIST);
      for (const g of shown) {
        const stateBadge = g.grade.customer_state === "angry" ? "🔥 angry"
          : g.grade.customer_state === "dissatisfied" ? "😟 dissatisfied"
          : g.grade.service_quality === "unsatisfactory" ? "⚠️ service issue"
          : "";
        const serviceBadge = g.grade.service_quality === "unsatisfactory" ? " · ⚠️ unsatisfactory reply"
          : g.grade.service_quality === "no_agent_reply" ? " · ⏳ no agent reply yet"
          : "";
        widgets.push({
          decoratedText: {
            topLabel: `Ticket #${g.ticket.id}  ·  ${stateBadge}${serviceBadge}`,
            text: escHtmlForCard(g.grade.reason),
            wrapText: true,
            button: {
              text: "Open ticket",
              onClick: { openLink: { url: `${BASE_URL}/a/tickets/${g.ticket.id}` } },
            },
          },
        });
      }
      if (items.length > MAX_LIST) {
        widgets.push({ textParagraph: { text: `<i>...and ${items.length - MAX_LIST} more not listed.</i>` } });
      }
      sections.push({ header, widgets });
    };

    renderGroup(`🔥 Angry customers (${angry.length})`, angry);
    renderGroup(`😟 Dissatisfied customers (${dissatisfied.length})`, dissatisfied);
    renderGroup(`⚠️ Service issues — customer didn't complain, but reply was unsatisfactory (${happyButBadService.length})`, happyButBadService);

    if (flagged.length === 0) {
      sections.push({
        widgets: [{ textParagraph: { text: `<b>✅ Nothing to flag.</b><br>${graded.length} tickets reviewed. No angry or dissatisfied customers, and no unsatisfactory replies.` } }],
      });
    }

    const headerIcon = flagged.length > 0 ? (angry.length > 0 ? "🔥" : "😟") : "✅";
    const headerTitle = `${headerIcon} Helpdesk Daily Review`;
    const headerSubtitle = `${periodLabel}  ·  ${graded.length} reviewed  ·  ${flagged.length} flagged`;

    const card = {
      cardId: "daily-review",
      card: {
        header: { title: headerTitle, subtitle: headerSubtitle },
        sections,
      },
    };

    const previewText = flagged.length > 0
      ? `🚨 Helpdesk: ${flagged.length} ticket${flagged.length === 1 ? "" : "s"} need attention (${angry.length} angry, ${dissatisfied.length} dissatisfied, ${happyButBadService.length} bad service)`
      : `✅ Helpdesk daily review — nothing to flag (${graded.length} reviewed)`;

    let chatStatus = "not_configured";
    if (GOOGLE_CHAT_WEBHOOK && !dryRun) {
      try {
        const chatResp = await fetch(GOOGLE_CHAT_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: previewText, cardsV2: [card] }),
        });
        chatStatus = chatResp.ok ? "sent" : `failed_${chatResp.status}: ${await chatResp.text()}`;
      } catch (e) {
        chatStatus = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else if (dryRun) {
      chatStatus = "dry_run";
    }

    return {
      period_hours: hours,
      since: sinceIso,
      tickets_inspected: allTickets.length,
      tickets_graded: graded.length,
      flagged: flagged.length,
      angry: angry.length,
      dissatisfied: dissatisfied.length,
      service_issues: happyButBadService.length,
      chat: chatStatus,
      preview_text: previewText,
      digest_text: digest,
      card,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[runDailyReview]", msg);
    return { error: msg };
  }
}

// ── Claude system prompts (loaded from external files) ──────────────────────

const TRIAGE_SYSTEM_PROMPT = await Bun.file("./triage-rules.md").text();
const RESPONSE_GUIDELINES = await Bun.file("./response-guidelines.md").text();

// ── Frontend HTML ────────────────────────────────────────────────────────────

function loginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helpdesk Triage - Login</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0a0f; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .login-box { background: #14141f; border: 1px solid #2a2a3a; border-radius: 12px; padding: 2.5rem; width: 360px; }
  h1 { font-size: 1.4rem; margin-bottom: 1.5rem; color: #fff; text-align: center; }
  label { display: block; font-size: 0.85rem; color: #888; margin-bottom: 0.4rem; }
  input { width: 100%; padding: 0.7rem 0.9rem; background: #1a1a2e; border: 1px solid #333; border-radius: 6px; color: #e0e0e0; font-size: 0.95rem; outline: none; margin-bottom: 1rem; }
  input:focus { border-color: #5b6ef5; }
  button { width: 100%; padding: 0.7rem; background: #5b6ef5; color: #fff; border: none; border-radius: 6px; font-size: 0.95rem; cursor: pointer; font-weight: 500; }
  button:hover { background: #4a5de0; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .error { color: #f55b5b; font-size: 0.85rem; margin-top: 0.8rem; text-align: center; display: none; }
</style>
</head>
<body>
<div class="login-box">
  <h1>Helpdesk Triage</h1>
  <form id="loginForm">
    <label for="username">Username</label>
    <input type="text" id="username" name="username" autocomplete="username" autofocus required>
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" required>
    <button type="submit" id="loginBtn">Log in</button>
    <div class="error" id="loginError"></div>
  </form>
</div>
<script>
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');
  btn.disabled = true;
  err.style.display = 'none';
  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      })
    });
    if (resp.ok) { window.location.reload(); }
    else { err.textContent = 'Invalid username or password'; err.style.display = 'block'; }
  } catch { err.textContent = 'Connection error'; err.style.display = 'block'; }
  btn.disabled = false;
});
</script>
</body>
</html>`;
}

function appPage(username: string, hasOwnKey: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Helpdesk</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #f6f6f8;
      color: #1c1c28;
      min-height: 100vh;
      padding: 1.5rem;
      line-height: 1.4;
    }
    .container { max-width: 1000px; margin: 0 auto; }

    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.2rem; }
    header h1 { font-size: 1.3rem; color: #1c1c28; font-weight: 600; }
    .header-meta { display: flex; align-items: center; gap: 0.8rem; font-size: 0.82rem; color: #585866; }
    .header-meta strong { color: #1c1c28; font-weight: 600; }

    .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid #dbdbe1; margin-bottom: 1.2rem; }
    .tab {
      background: none; border: none; padding: 0.6rem 1.1rem;
      font-size: 0.92rem; font-weight: 500; color: #585866;
      cursor: pointer; border-bottom: 2px solid transparent;
      margin-bottom: -1px; display: flex; align-items: center; gap: 0.5rem;
      font-family: inherit;
    }
    .tab:hover { color: #1c1c28; }
    .tab.active { color: #4a5db8; border-bottom-color: #4a5db8; }
    .tab-badge {
      background: #ebebf0; color: #585866; padding: 0.05rem 0.5rem;
      border-radius: 99px; font-size: 0.75rem; font-weight: 500;
    }
    .tab.active .tab-badge { background: #4a5db8; color: #fff; }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .card {
      background: #ffffff; border: 1px solid #dbdbe1;
      border-radius: 8px; padding: 1.2rem 1.4rem; margin-bottom: 1rem;
    }
    .card h2 { font-size: 1.05rem; color: #1c1c28; margin-bottom: 0.5rem; font-weight: 600; }
    .card-hint { font-size: 0.85rem; color: #585866; margin-bottom: 0.8rem; }

    .btn {
      padding: 0.55rem 1.2rem; border: none; border-radius: 6px;
      font-size: 0.88rem; cursor: pointer; font-weight: 500;
      transition: background 0.15s; font-family: inherit;
    }
    .btn-primary { background: #4a5db8; color: #fff; }
    .btn-primary:hover { background: #3a4da8; }
    .btn-danger { background: #c73a3a; color: #fff; }
    .btn-danger:hover { background: #b02e2e; }
    .btn-success { background: #2d8a4d; color: #fff; }
    .btn-success:hover { background: #257540; }
    .btn-secondary { background: #ebebf0; color: #1c1c28; }
    .btn-secondary:hover { background: #dfdfe7; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .status { font-size: 0.85rem; color: #585866; margin-top: 0.6rem; }
    .status.error { color: #c73a3a; }
    .status.ok { color: #2d8a4d; }

    .progress-bar { width: 100%; height: 4px; background: #ebebf0; border-radius: 2px; margin-top: 0.6rem; overflow: hidden; }
    .progress-fill { height: 100%; background: #4a5db8; transition: width 0.3s; border-radius: 2px; }

    .group { margin-top: 1rem; border-radius: 6px; overflow: hidden; border: 1px solid #dbdbe1; }
    .group-title { font-size: 0.9rem; font-weight: 600; padding: 0.55rem 0.8rem; }
    .group-close { background: #e7f2ea; color: #1f6a37; border-left: 3px solid #4f9560; }
    .group-escalate-both { background: #f9e6e6; color: #98302f; border-left: 3px solid #c75a5a; }
    .group-escalate-amar { background: #faf2dd; color: #7a5818; border-left: 3px solid #b89530; }
    .group-forward-drafts { background: #e0eef3; color: #2a5c70; border-left: 3px solid #5798b0; }
    .group-leave { background: #e8eaf5; color: #404a8a; border-left: 3px solid #6e7bbf; }

    .ticket-card {
      background: #ffffff; border-top: 1px solid #ebebf0;
      padding: 0.7rem 0.9rem; display: flex; flex-direction: column; gap: 0.4rem;
      font-size: 0.88rem;
    }
    .ticket-card:first-child { border-top: none; }
    .ticket-row { display: flex; align-items: center; gap: 0.75rem; width: 100%; flex-wrap: wrap; }
    .ticket-id { color: #4a5db8; font-family: ui-monospace, SF Mono, Monaco, monospace; flex-shrink: 0; min-width: 70px; text-decoration: none; font-size: 0.85rem; }
    .ticket-id:hover { text-decoration: underline; }
    .ticket-subject { flex: 1; color: #1c1c28; font-weight: 500; min-width: 200px; }
    .ticket-reason { color: #7a7a85; font-size: 0.8rem; flex-shrink: 0; font-style: italic; }
    .ticket-action-select {
      background: #ffffff; border: 1px solid #c0c0c8; color: #1c1c28;
      padding: 0.3rem 0.5rem; border-radius: 4px; font-size: 0.82rem; font-family: inherit;
    }
    .ticket-sender { color: #585866; font-size: 0.82rem; }
    .ticket-sender strong { color: #1c1c28; font-weight: 500; }

    .ticket-body {
      background: #fafafa; border: 1px solid #ebebf0; border-radius: 4px;
      padding: 0.6rem 0.8rem; font-size: 0.83rem; color: #2a2a35;
      max-height: 180px; overflow-y: auto; white-space: pre-wrap;
      line-height: 1.5; font-family: inherit;
    }

    .summary { display: flex; gap: 0.5rem; font-size: 0.8rem; margin-top: 1rem; flex-wrap: wrap; }
    .summary span { padding: 0.25rem 0.65rem; border-radius: 4px; font-weight: 500; }
    .s-close { background: #e7f2ea; color: #1f6a37; }
    .s-esc-both { background: #f9e6e6; color: #98302f; }
    .s-esc-amar { background: #faf2dd; color: #7a5818; }
    .s-fwd-drafts { background: #e0eef3; color: #2a5c70; }
    .s-leave { background: #e8eaf5; color: #404a8a; }

    .result-ok { color: #2d8a4d; }
    .result-fail { color: #c73a3a; }
    .result-skip { color: #585866; }
    .exec-results { margin-top: 0.6rem; font-size: 0.82rem; }
    .exec-results div { padding: 0.15rem 0; font-family: ui-monospace, SF Mono, Monaco, monospace; }

    .ticket-instr-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .ticket-instr-label { font-size: 0.76rem; color: #7a7a85; flex-shrink: 0; font-weight: 500; }
    .ticket-instr {
      flex: 1; background: #ffffff; border: 1px solid #c0c0c8; color: #1c1c28;
      padding: 0.4rem 0.7rem; border-radius: 4px; font-size: 0.85rem;
      outline: none; font-family: inherit; min-width: 200px;
    }
    .ticket-instr:focus { border-color: #4a5db8; }
    .ticket-instr::placeholder { color: #a0a0aa; }

    .btn-draft {
      background: #4a5db8; color: #fff; padding: 0.45rem 0.95rem;
      border-radius: 4px; font-size: 0.82rem; border: none; cursor: pointer;
      font-weight: 500; flex-shrink: 0; font-family: inherit;
    }
    .btn-draft:hover { background: #3a4da8; }
    .btn-draft.active { background: #2d8a4d; }

    .draft-panel {
      padding: 0.8rem 0.9rem; background: #fafafa; border: 1px solid #dbdbe1;
      border-radius: 6px; margin-top: 0.3rem;
      display: flex; flex-direction: column; gap: 0.55rem;
    }
    .draft-loading { color: #585866; font-style: italic; padding: 0.3rem 0; font-size: 0.85rem; }
    .draft-textarea {
      width: 100%; min-height: 200px; background: #ffffff;
      border: 1px solid #c0c0c8; border-radius: 4px; color: #1c1c28;
      padding: 0.7rem; font-family: inherit; font-size: 0.88rem;
      line-height: 1.5; resize: vertical; outline: none;
    }
    .draft-textarea:focus { border-color: #4a5db8; }
    .draft-controls { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .draft-controls input[type="file"] { color: #585866; font-size: 0.8rem; max-width: 260px; font-family: inherit; }
    .btn-send-reply { background: #2d8a4d; color: #fff; padding: 0.45rem 1rem; border-radius: 4px; font-size: 0.85rem; border: none; cursor: pointer; font-weight: 500; font-family: inherit; }
    .btn-send-reply:hover { background: #247540; }
    .btn-send-note { background: #4a5db8; color: #fff; padding: 0.45rem 1rem; border-radius: 4px; font-size: 0.85rem; border: none; cursor: pointer; font-weight: 500; font-family: inherit; }
    .btn-send-note:hover { background: #3a4da8; }
    .btn-redraft { background: #ebebf0; color: #1c1c28; padding: 0.45rem 1rem; border-radius: 4px; font-size: 0.85rem; border: none; cursor: pointer; font-family: inherit; }
    .btn-redraft:hover { background: #dfdfe7; }
    .btn-send-reply:disabled, .btn-send-note:disabled, .btn-redraft:disabled { opacity: 0.4; cursor: not-allowed; }
    .draft-status { font-size: 0.82rem; color: #585866; min-height: 1em; }
    .draft-status.ok { color: #2d8a4d; }
    .draft-status.error { color: #c73a3a; }
    .draft-error { color: #c73a3a; font-size: 0.85rem; padding: 0.3rem 0; }

    .draft-ticket {
      background: #ffffff; border: 1px solid #dbdbe1; border-radius: 8px;
      padding: 1rem 1.2rem; margin-bottom: 1rem;
      display: flex; flex-direction: column; gap: 0.6rem;
    }
    .draft-ticket-header { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; }
    .draft-ticket-header h3 { font-size: 1rem; color: #1c1c28; font-weight: 600; flex: 1; min-width: 200px; }
    .btn-thread {
      background: #ebebf0; color: #585866; padding: 0.3rem 0.75rem;
      border-radius: 4px; font-size: 0.78rem; border: none; cursor: pointer; font-family: inherit;
    }
    .btn-thread:hover { background: #dfdfe7; color: #1c1c28; }
    .btn-thread.loaded { background: #4a5db8; color: #fff; }
    .thread-panel {
      background: #f0f0f4; border: 1px solid #dbdbe1; border-radius: 6px;
      padding: 0.7rem 0.9rem; max-height: 360px; overflow-y: auto;
      font-size: 0.83rem; display: flex; flex-direction: column; gap: 0.7rem;
    }
    .thread-msg {
      padding: 0.55rem 0.75rem; border-radius: 4px; border-left: 3px solid;
    }
    .thread-msg.incoming { background: #ffffff; border-left-color: #4a5db8; }
    .thread-msg.outgoing { background: #fafafd; border-left-color: #7a7a85; }
    .thread-msg.private { background: #faf2dd; border-left-color: #b89530; }
    .thread-meta { font-size: 0.74rem; color: #585866; margin-bottom: 0.3rem; }
    .thread-meta strong { color: #1c1c28; }
    .thread-body { color: #2a2a35; white-space: pre-wrap; line-height: 1.5; }
    .thread-attachments { font-size: 0.78rem; color: #585866; margin-top: 0.35rem; }
    .thread-attachments a { color: #4a5db8; }
    .draft-empty { color: #7a7a85; font-size: 0.9rem; padding: 2rem 0; text-align: center; font-style: italic; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Helpdesk</h1>
      <div class="header-meta">
        <span>Logged in as <strong>${username}</strong>${hasOwnKey ? '' : ' <span style="color:#b07020;" title="No personal Freshdesk API key set — sends use the shared FRESHDESK_API_KEY">(shared key)</span>'}</span>
        <span style="color:#a0a0aa;">·</span>
        <span>Swarajya / Kovai Media</span>
      </div>
    </header>

    <nav class="tabs" role="tablist">
      <button class="tab active" data-tab="fetch" onclick="showTab('fetch')">Fetch <span class="tab-badge" id="badge-fetch">0</span></button>
      <button class="tab" data-tab="classify" onclick="showTab('classify')">Classify <span class="tab-badge" id="badge-classify">0</span></button>
      <button class="tab" data-tab="draft" onclick="showTab('draft')">Draft <span class="tab-badge" id="badge-draft">0</span></button>
    </nav>

    <!-- Tab 1: Fetch -->
    <div class="tab-content active" id="tab-fetch">
      <div class="card">
        <h2>Fetch open tickets</h2>
        <div class="card-hint">Pulls open tickets from Freshdesk that aren't yet tagged "Checked". Run this first.</div>
        <button class="btn btn-primary" id="fetchBtn" onclick="startFetch()">Fetch Open Tickets</button>
        <div class="progress-bar" id="fetchProgress" style="display:none"><div class="progress-fill" id="fetchFill"></div></div>
        <div class="status" id="fetchStatus"></div>
      </div>
    </div>

    <!-- Tab 2: Classify -->
    <div class="tab-content" id="tab-classify">
      <div class="card">
        <h2>Classify with Claude</h2>
        <div class="card-hint">Claude reads each ticket and suggests an action: close, escalate, forward to drafts, or leave. Adjust the dropdown if you disagree. The full original message is shown for each ticket.</div>
        <button class="btn btn-primary" id="classifyBtn" onclick="startClassify()">Classify Tickets</button>
        <div class="status" id="classifyStatus"></div>
        <div class="summary" id="classifySummary" style="display:none"></div>
        <div id="classifyResults" style="margin-top:1rem;"></div>
      </div>

      <div class="card" id="executeCard" style="display:none;">
        <h2>Execute</h2>
        <div class="card-hint">Apply the actions in Freshdesk. <strong>Leave</strong> tickets stay open and become available in the Draft tab. <strong>Execute + Draft Leave Replies</strong> additionally auto-posts a suggested reply as a private note on each leave ticket.</div>
        <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
          <button class="btn btn-danger" id="executeBtn" onclick="startExecute(false)">Execute Actions</button>
          <button class="btn btn-primary" id="executeDraftBtn" onclick="startExecute(true)">Execute + Draft Leave Replies</button>
        </div>
        <div class="status" id="executeStatus"></div>
        <div class="exec-results" id="executeResults"></div>
        <div class="status" id="draftBatchStatus" style="display:none;"></div>
        <div class="exec-results" id="draftBatchResults"></div>
      </div>
    </div>

    <!-- Tab 3: Draft -->
    <div class="tab-content" id="tab-draft">
      <div class="card">
        <h2>Draft replies</h2>
        <div class="card-hint">Tickets needing a thoughtful customer reply. Read the original message (and the full thread if needed), add instructions for Claude, then draft, edit, and send.</div>
        <div id="draftList">
          <div class="draft-empty">No leave tickets yet. Run Fetch and Classify first.</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const FRESHDESK_BASE = '${BASE_URL}';

    let allTickets = [];
    let triageResults = [];
    const openDrafts = {};
    const ticketInstructions = {};
    const loadedThreads = {};

    function ticketMap() {
      const m = {};
      allTickets.forEach(t => m[t.id] = t);
      return m;
    }

    function escHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function showTab(tab) {
      document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
      document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tab));
      if (tab === 'draft') renderDraftTab();
    }

    function updateBadges() {
      document.getElementById('badge-fetch').textContent = allTickets.length;
      document.getElementById('badge-classify').textContent = triageResults.length;
      const leaveCount = triageResults.filter(r => r.action === 'leave').length;
      document.getElementById('badge-draft').textContent = leaveCount;
    }

    // ── Tab 1: Fetch ──
    async function startFetch() {
      const btn = document.getElementById('fetchBtn');
      const status = document.getElementById('fetchStatus');
      const progressBar = document.getElementById('fetchProgress');
      const progressFill = document.getElementById('fetchFill');

      btn.disabled = true;
      allTickets = [];
      status.className = 'status';
      progressBar.style.display = 'block';
      progressFill.style.width = '0%';

      let page = 1;
      let consecutiveEmpty = 0;
      const maxEmptyPages = 3;

      try {
        while (true) {
          status.textContent = 'Fetching page ' + page + '...';
          progressFill.style.width = Math.min(page * 10, 90) + '%';
          const resp = await fetch('/api/tickets?page=' + page);
          if (!resp.ok) {
            const data = await resp.json();
            throw new Error(data.error || 'Fetch failed');
          }
          const data = await resp.json();
          if (data.unchecked === 0) {
            consecutiveEmpty++;
          } else {
            consecutiveEmpty = 0;
            allTickets.push(...data.tickets);
          }
          updateBadges();
          status.textContent = 'Page ' + page + ': ' + data.unchecked + ' unchecked (total: ' + allTickets.length + ')';
          if (!data.has_more || consecutiveEmpty >= maxEmptyPages) break;
          page++;
        }
        progressFill.style.width = '100%';
        if (allTickets.length === 0) {
          status.textContent = 'No unchecked open tickets found.';
        } else {
          status.textContent = '✓ Fetched ' + allTickets.length + ' tickets. Open the Classify tab.';
          status.className = 'status ok';
        }
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'status error';
      }
      btn.disabled = false;
    }

    // ── Tab 2: Classify ──
    async function startClassify() {
      const btn = document.getElementById('classifyBtn');
      const status = document.getElementById('classifyStatus');
      const summaryDiv = document.getElementById('classifySummary');
      const resultsDiv = document.getElementById('classifyResults');

      if (allTickets.length === 0) {
        status.textContent = 'No tickets to classify. Open the Fetch tab first.';
        status.className = 'status error';
        return;
      }

      btn.disabled = true;
      resultsDiv.innerHTML = '';
      summaryDiv.style.display = 'none';
      status.className = 'status';
      status.textContent = 'Sending ' + allTickets.length + ' tickets to Claude...';

      try {
        const resp = await fetch('/api/triage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tickets: allTickets })
        });
        if (!resp.ok) {
          const data = await resp.json();
          throw new Error(data.error || 'Triage failed');
        }
        const data = await resp.json();
        triageResults = data.results;
        updateBadges();
        status.textContent = '✓ Classified ' + triageResults.length + ' tickets.';
        status.className = 'status ok';
        renderClassifications();
        document.getElementById('executeCard').style.display = 'block';
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'status error';
      }
      btn.disabled = false;
    }

    function renderClassifications() {
      const resultsDiv = document.getElementById('classifyResults');
      const summaryDiv = document.getElementById('classifySummary');
      const tm = ticketMap();

      const groups = {
        close: triageResults.filter(r => r.action === 'close'),
        escalate_both: triageResults.filter(r => r.action === 'escalate_both'),
        escalate_amar: triageResults.filter(r => r.action === 'escalate_amar'),
        forward_drafts: triageResults.filter(r => r.action === 'forward_drafts'),
        leave: triageResults.filter(r => r.action === 'leave'),
      };
      const groupConfig = [
        { key: 'close', label: 'Close', css: 'group-close' },
        { key: 'escalate_both', label: 'Escalate Both', css: 'group-escalate-both' },
        { key: 'escalate_amar', label: 'Escalate Amar', css: 'group-escalate-amar' },
        { key: 'forward_drafts', label: 'Forward to Drafts', css: 'group-forward-drafts' },
        { key: 'leave', label: 'Leave (handle in Draft tab)', css: 'group-leave' },
      ];

      let html = '';
      for (const gc of groupConfig) {
        const items = groups[gc.key];
        if (!items.length) continue;
        html += '<div class="group">';
        html += '<div class="group-title ' + gc.css + '">' + gc.label + ' (' + items.length + ')</div>';
        for (const r of items) {
          const t = tm[r.id] || {};
          const fromName = t.from_name || '';
          const fromEmail = t.from_email || 'unknown';
          const senderDisplay = fromName ? fromName + ' <' + fromEmail + '>' : fromEmail;
          html += '<div class="ticket-card">';
          html += '<div class="ticket-row">';
          html += '<a class="ticket-id" href="' + FRESHDESK_BASE + '/a/tickets/' + r.id + '" target="_blank">#' + r.id + '</a>';
          html += '<span class="ticket-subject">' + escHtml(t.subject || '') + '</span>';
          html += '<span class="ticket-reason">' + escHtml(r.reason || '') + '</span>';
          html += '<select class="ticket-action-select" onchange="updateAction(' + r.id + ', this.value)">';
          html += optionHtml('close', r.action);
          html += optionHtml('escalate_both', r.action);
          html += optionHtml('escalate_amar', r.action);
          html += optionHtml('forward_drafts', r.action);
          html += optionHtml('leave', r.action);
          html += '</select>';
          html += '</div>';
          html += '<div class="ticket-sender"><strong>From:</strong> ' + escHtml(senderDisplay) + '</div>';
          if (t.description_text) {
            html += '<div class="ticket-body">' + escHtml(t.description_text) + '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      resultsDiv.innerHTML = html;

      summaryDiv.style.display = 'flex';
      summaryDiv.innerHTML =
        '<span class="s-close">' + groups.close.length + ' close</span>' +
        '<span class="s-esc-both">' + groups.escalate_both.length + ' escalate both</span>' +
        '<span class="s-esc-amar">' + groups.escalate_amar.length + ' escalate amar</span>' +
        '<span class="s-fwd-drafts">' + groups.forward_drafts.length + ' drafts</span>' +
        '<span class="s-leave">' + groups.leave.length + ' leave</span>';
    }

    function optionHtml(value, selected) {
      const labels = { close: 'Close', escalate_both: 'Escalate Both', escalate_amar: 'Escalate Amar', forward_drafts: 'Forward to Drafts', leave: 'Leave' };
      return '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + labels[value] + '</option>';
    }

    function updateAction(id, newAction) {
      const r = triageResults.find(r => r.id === id);
      if (r) {
        r.action = newAction;
        updateBadges();
        renderClassifications();
      }
    }

    // ── Tab 2: Execute ──
    async function startExecute(alsoDraft) {
      const btn = document.getElementById('executeBtn');
      const btnDraft = document.getElementById('executeDraftBtn');
      const status = document.getElementById('executeStatus');
      const resultsDiv = document.getElementById('executeResults');
      const tm = ticketMap();

      btn.disabled = true; btnDraft.disabled = true;
      resultsDiv.innerHTML = '';
      document.getElementById('draftBatchResults').innerHTML = '';
      document.getElementById('draftBatchStatus').style.display = 'none';
      status.className = 'status';

      const actions = triageResults.map(r => {
        const t = tm[r.id];
        return { id: r.id, action: r.action, tags: t ? t.tags : undefined };
      });
      const actionable = actions.filter(a => a.action !== 'leave');
      const skipped = actions.filter(a => a.action === 'leave');
      status.textContent = 'Executing ' + actionable.length + ' actions (' + skipped.length + ' leave for Draft tab)...';

      try {
        const resp = await fetch('/api/execute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actions })
        });
        if (!resp.ok) {
          const data = await resp.json();
          throw new Error(data.error || 'Execute failed');
        }
        const data = await resp.json();
        let okCount = 0, failCount = 0, skipCount = 0;
        let html = '';
        for (const r of data.results) {
          const cls = r.status === 'OK' ? 'result-ok' : r.status === 'SKIP' ? 'result-skip' : 'result-fail';
          html += '<div class="' + cls + '">#' + r.id + ' ' + r.action + ': ' + r.status + ' — ' + escHtml(r.detail) + '</div>';
          if (r.status === 'OK') okCount++; else if (r.status === 'SKIP') skipCount++; else failCount++;
        }
        resultsDiv.innerHTML = html;
        status.textContent = '✓ ' + okCount + ' OK, ' + failCount + ' failed, ' + skipCount + ' skipped (in Draft tab).';
        status.className = failCount > 0 ? 'status error' : 'status ok';

        if (alsoDraft) {
          await bulkDraftLeaveReplies();
        }
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'status error';
      }
      btn.disabled = false; btnDraft.disabled = false;
    }

    async function bulkDraftLeaveReplies() {
      const status = document.getElementById('draftBatchStatus');
      const resultsDiv = document.getElementById('draftBatchResults');
      status.style.display = 'block';
      status.className = 'status';
      resultsDiv.innerHTML = '';

      const leaveIds = triageResults.filter(r => r.action === 'leave').map(r => r.id);
      if (!leaveIds.length) {
        status.textContent = 'No leave tickets to draft.';
        return;
      }
      let ok = 0, skip = 0, fail = 0, done = 0;
      status.textContent = 'Drafting ' + leaveIds.length + ' leave ticket(s)...';

      const CONCURRENCY = 3;
      let idx = 0;
      async function worker() {
        while (idx < leaveIds.length) {
          const i = idx++;
          const id = leaveIds[i];
          try {
            const resp = await fetch('/api/draft-leave-one', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ticket_id: id })
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Draft failed');
            const cls = data.status === 'OK' ? 'result-ok' : data.status === 'SKIP' ? 'result-skip' : 'result-fail';
            resultsDiv.innerHTML += '<div class="' + cls + '">#' + id + ' draft: ' + data.status + ' — ' + escHtml(data.detail || '') + '</div>';
            if (data.status === 'OK') ok++; else if (data.status === 'SKIP') skip++; else fail++;
          } catch (e) {
            resultsDiv.innerHTML += '<div class="result-fail">#' + id + ' draft: FAIL — ' + escHtml(e.message) + '</div>';
            fail++;
          }
          done++;
          status.textContent = 'Drafting... ' + done + '/' + leaveIds.length + ' (' + ok + ' OK, ' + skip + ' skipped, ' + fail + ' failed)';
        }
      }
      const workers = Array.from({ length: Math.min(CONCURRENCY, leaveIds.length) }, () => worker());
      await Promise.all(workers);
      status.textContent = '✓ Drafts done. ' + ok + ' posted, ' + skip + ' skipped, ' + fail + ' failed.';
      status.className = fail > 0 ? 'status error' : 'status ok';
    }

    // ── Tab 3: Draft ──
    function renderDraftTab() {
      const container = document.getElementById('draftList');
      const tm = ticketMap();
      const leave = triageResults.filter(r => r.action === 'leave');

      if (leave.length === 0) {
        container.innerHTML = '<div class="draft-empty">No leave tickets yet. Run Fetch and Classify first.</div>';
        return;
      }

      let html = '';
      for (const r of leave) {
        const t = tm[r.id] || {};
        const fromName = t.from_name || '';
        const fromEmail = t.from_email || 'unknown';
        const senderDisplay = fromName ? fromName + ' <' + fromEmail + '>' : fromEmail;
        const instrVal = ticketInstructions[r.id] || '';
        html += '<div class="draft-ticket">';
        html += '<div class="draft-ticket-header">';
        html += '<a class="ticket-id" href="' + FRESHDESK_BASE + '/a/tickets/' + r.id + '" target="_blank">#' + r.id + '</a>';
        html += '<h3>' + escHtml(t.subject || '(no subject)') + '</h3>';
        html += '<button class="btn-thread" id="thread-btn-' + r.id + '" onclick="toggleThread(' + r.id + ')">View full thread</button>';
        html += '</div>';
        html += '<div class="ticket-sender"><strong>From:</strong> ' + escHtml(senderDisplay) + '</div>';
        if (t.description_text) {
          html += '<div class="ticket-body">' + escHtml(t.description_text) + '</div>';
        }
        html += '<div class="thread-panel" id="thread-' + r.id + '" style="display:none"></div>';
        html += '<div class="ticket-instr-row">';
        html += '<span class="ticket-instr-label">→ Claude:</span>';
        html += '<input type="text" class="ticket-instr" id="ticket-instr-' + r.id + '" placeholder="Optional: be firm, mention refund policy, reply in Hindi, etc." value="' + escHtml(instrVal) + '" oninput="onTicketInstrEdit(' + r.id + ')">';
        html += '<button class="btn-draft" id="draft-btn-' + r.id + '" onclick="toggleDraft(' + r.id + ')">Draft Reply</button>';
        html += '</div>';
        html += '<div class="draft-panel" id="draft-' + r.id + '" style="display:none"></div>';
        html += '</div>';
      }
      container.innerHTML = html;
      restoreOpenDrafts();
      // restore loaded threads
      for (const id of Object.keys(loadedThreads)) {
        const panel = document.getElementById('thread-' + id);
        const btn = document.getElementById('thread-btn-' + id);
        if (panel && loadedThreads[id]) {
          panel.style.display = 'block';
          if (btn) btn.classList.add('loaded');
          renderThread(parseInt(id, 10));
        }
      }
    }

    async function toggleThread(id) {
      const panel = document.getElementById('thread-' + id);
      const btn = document.getElementById('thread-btn-' + id);
      if (!panel) return;
      if (panel.style.display !== 'none' && loadedThreads[id]) {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = 'block';
      if (loadedThreads[id]) {
        renderThread(id);
        return;
      }
      panel.innerHTML = '<div class="draft-loading">Loading full thread...</div>';
      try {
        const resp = await fetch('/api/ticket-thread?id=' + id);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Thread load failed');
        loadedThreads[id] = { messages: data.messages };
        if (btn) btn.classList.add('loaded');
        renderThread(id);
      } catch (e) {
        panel.innerHTML = '<div class="draft-error">Failed to load thread: ' + escHtml(e.message) + '</div>';
      }
    }

    function renderThread(id) {
      const panel = document.getElementById('thread-' + id);
      if (!panel || !loadedThreads[id]) return;
      const messages = loadedThreads[id].messages;
      let html = '';
      for (const m of messages) {
        const cls = m.private ? 'private' : (m.incoming ? 'incoming' : 'outgoing');
        const label = m.private ? 'Private note (agent)' : (m.incoming ? 'Incoming · customer' : 'Outgoing · agent');
        const when = (m.created_at || '').replace('T', ' ').slice(0, 16);
        html += '<div class="thread-msg ' + cls + '">';
        html += '<div class="thread-meta"><strong>' + escHtml(label) + '</strong> · ' + escHtml(when) + ' · From: ' + escHtml(m.from || '?') + '</div>';
        html += '<div class="thread-body">' + escHtml(m.body_text || '') + '</div>';
        if (m.attachments && m.attachments.length) {
          html += '<div class="thread-attachments">📎 ';
          html += m.attachments.map(a => '<a href="' + a.url + '" target="_blank">' + escHtml(a.name) + '</a> (' + Math.round(a.size / 1024) + 'KB)').join(', ');
          html += '</div>';
        }
        html += '</div>';
      }
      panel.innerHTML = html;
    }

    function onTicketInstrEdit(id) {
      const el = document.getElementById('ticket-instr-' + id);
      if (el) ticketInstructions[id] = el.value;
    }

    function getInlineInstructions(id) {
      const el = document.getElementById('ticket-instr-' + id);
      if (el) return el.value;
      return ticketInstructions[id] || '';
    }

    function restoreOpenDrafts() {
      for (const id of Object.keys(openDrafts)) {
        const state = openDrafts[id];
        const panel = document.getElementById('draft-' + id);
        const btn = document.getElementById('draft-btn-' + id);
        if (!panel) continue;
        panel.style.display = 'block';
        if (btn) btn.classList.add('active');
        if (state.draft === null) {
          panel.innerHTML = '<div class="draft-loading">Drafting reply with Claude...</div>';
          loadDraft(id);
        } else {
          renderDraftPanel(id, state.draft, state.status);
        }
      }
    }

    function toggleDraft(id) {
      const panel = document.getElementById('draft-' + id);
      const btn = document.getElementById('draft-btn-' + id);
      if (!panel) return;
      if (openDrafts[id]) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        if (btn) btn.classList.remove('active');
        delete openDrafts[id];
      } else {
        openDrafts[id] = { draft: null, status: null };
        panel.style.display = 'block';
        panel.innerHTML = '<div class="draft-loading">Drafting reply with Claude...</div>';
        if (btn) btn.classList.add('active');
        loadDraft(id);
      }
    }

    async function loadDraft(id) {
      const panel = document.getElementById('draft-' + id);
      if (!panel) return;
      if (!openDrafts[id]) openDrafts[id] = { draft: null, status: null };
      const instructions = getInlineInstructions(id);
      panel.innerHTML = '<div class="draft-loading">Drafting reply with Claude' + (instructions ? ' (using your instructions)' : '') + '...</div>';
      openDrafts[id].draft = null;
      try {
        const resp = await fetch('/api/draft-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket_id: id, instructions })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Draft failed');
        openDrafts[id].draft = data.draft || '';
        let initialStatus = null;
        if (data.images_total > 0) {
          const considered = data.images_considered || 0;
          const skipped = data.images_total - considered;
          const msg = considered > 0
            ? '📷 ' + considered + ' image' + (considered === 1 ? '' : 's') + ' considered' + (skipped > 0 ? ' (' + skipped + ' skipped)' : '')
            : '📷 ' + data.images_total + ' image' + (data.images_total === 1 ? '' : 's') + ' present but could not be loaded';
          initialStatus = { text: msg, cls: '' };
        }
        openDrafts[id].status = initialStatus;
        renderDraftPanel(id, openDrafts[id].draft, initialStatus);
      } catch (e) {
        if (!openDrafts[id]) return;
        panel.innerHTML = '<div class="draft-error">Error: ' + escHtml(e.message) + '</div>' +
          '<div class="draft-controls"><button class="btn-redraft" onclick="loadDraft(' + id + ')">Retry</button></div>';
      }
    }

    function renderDraftPanel(id, draftText, status) {
      const panel = document.getElementById('draft-' + id);
      if (!panel) return;
      const statusHtml = status
        ? '<div class="draft-status ' + (status.cls || '') + '" id="draft-status-' + id + '">' + escHtml(status.text) + '</div>'
        : '<div class="draft-status" id="draft-status-' + id + '"></div>';
      panel.innerHTML =
        '<textarea class="draft-textarea" id="draft-text-' + id + '" oninput="onDraftEdit(' + id + ')">' + escHtml(draftText) + '</textarea>' +
        '<div class="draft-controls">' +
          '<input type="file" id="draft-files-' + id + '" multiple>' +
          '<button class="btn-send-reply" onclick="sendDraft(' + id + ', \\'reply\\')">Send as Reply</button>' +
          '<button class="btn-send-note" onclick="sendDraft(' + id + ', \\'note\\')">Save as Note</button>' +
          '<button class="btn-redraft" onclick="loadDraft(' + id + ')">Re-draft with instructions above</button>' +
        '</div>' +
        statusHtml;
    }

    function onDraftEdit(id) {
      const ta = document.getElementById('draft-text-' + id);
      if (ta && openDrafts[id]) openDrafts[id].draft = ta.value;
    }

    async function sendDraft(id, kind) {
      const ta = document.getElementById('draft-text-' + id);
      const files = document.getElementById('draft-files-' + id);
      const status = document.getElementById('draft-status-' + id);
      if (!ta) return;
      const body = ta.value;
      if (!body.trim()) {
        if (status) { status.textContent = 'Body is empty'; status.className = 'draft-status error'; }
        return;
      }
      const sendButtons = document.querySelectorAll('#draft-' + id + ' button');
      sendButtons.forEach(b => b.disabled = true);
      if (status) { status.textContent = 'Sending...'; status.className = 'draft-status'; }

      const fd = new FormData();
      fd.append('ticket_id', String(id));
      fd.append('kind', kind);
      fd.append('body', body);
      if (files) {
        for (const f of files.files) fd.append('attachments', f);
      }
      try {
        const resp = await fetch('/api/send-reply', { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Send failed');
        const msg = kind === 'reply'
          ? '✓ Reply sent to customer' + (data.attachments ? ' (' + data.attachments + ' attachment' + (data.attachments === 1 ? '' : 's') + ')' : '')
          : '✓ Saved as internal note';
        openDrafts[id].status = { text: msg, cls: 'ok' };
        if (status) { status.textContent = msg; status.className = 'draft-status ok'; }
      } catch (e) {
        const msg = 'Error: ' + e.message;
        openDrafts[id].status = { text: msg, cls: 'error' };
        if (status) { status.textContent = msg; status.className = 'draft-status error'; }
      }
      sendButtons.forEach(b => b.disabled = false);
    }
  </script>
</body>
</html>`;
}
// ── Server ───────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  idleTimeout: 120, // 2 minutes for Claude API calls
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check (no auth required) - returns missing env vars for debugging
    if (path === "/health") {
      const missing = checkEnvVars();
      return Response.json({
        status: missing.length ? "degraded" : "ok",
        missing: missing.length ? missing : undefined
      });
    }

    // Check env vars before processing any other request
    const missing = checkEnvVars();
    if (missing.length) {
      return Response.json(
        { error: "Server not configured", missing },
        { status: 503 }
      );
    }

    // API routes
    if (path === "/api/login" && req.method === "POST") return handleLogin(req);
    if (path === "/api/tickets" && req.method === "GET") return handleFetchTickets(req);
    if (path === "/api/triage" && req.method === "POST") return handleTriage(req);
    if (path === "/api/execute" && req.method === "POST") return handleExecute(req);
    if (path === "/api/draft-reply" && req.method === "POST") return handleDraftReply(req);
    if (path === "/api/send-reply" && req.method === "POST") return handleSendReply(req);
    if (path === "/api/draft-leave-one" && req.method === "POST") return handleDraftLeaveOne(req);
    if (path === "/api/ticket-thread" && req.method === "GET") return handleTicketThread(req);
    if (path === "/api/daily-review" && (req.method === "POST" || req.method === "GET")) return handleDailyReview(req);

    // Main page
    if (path === "/") {
      const session = getSession(req);
      const html = session ? appPage(session.username, USER_KEYS.has(session.username)) : loginPage();
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Helpdesk Triage running on http://localhost:${PORT}`);
