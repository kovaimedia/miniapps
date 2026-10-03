#!/usr/bin/env bun
/**
 * compare-graders.ts
 *
 * Grades the same batch of tickets with both Haiku 4.5 and Sonnet 4.6 and
 * reports where they disagree. Purpose: calibrate whether Haiku is safe to
 * use for the daily-review grader (which would cut its cost ~70%).
 *
 * Usage:  cd freshdesk && bun compare-graders.ts [ticket_limit]
 *         (defaults to 15 tickets — enough signal, low cost)
 */

const TICKET_LIMIT = parseInt(process.argv[2] || "15", 10);

const API_KEY = process.env.FRESHDESK_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DOMAIN = process.env.FRESHDESK_DOMAIN || "swarajyasubscriptions";
if (!API_KEY || !ANTHROPIC_KEY) {
  console.error("FRESHDESK_API_KEY / ANTHROPIC_API_KEY missing in env");
  process.exit(1);
}

const BASE = `https://${DOMAIN}.freshdesk.com`;
const AUTH = `Basic ${btoa(`${API_KEY}:X`)}`;
const RESPONSE_GUIDELINES = await Bun.file("./response-guidelines.md").text();
const FORWARD_DRAFTS_AUTO_REPLY_PREFIX = "Thank you for sending your draft. We receive dozens of emails";

const MODEL_HAIKU = "claude-haiku-4-5";
const MODEL_SONNET = "claude-sonnet-4-6";

interface FdTicket {
  id: number;
  subject: string;
  status: number;
  created_at: string;
  updated_at: string;
  requester_id: number;
  description_text?: string;
  requester?: { id: number; name: string; email: string };
}
interface FdConversation {
  id: number;
  body_text?: string;
  body?: string;
  incoming: boolean;
  private: boolean;
  from_email?: string;
  to_emails?: string[];
  created_at: string;
}

async function fd<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

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

// --- Grading (identical to production, but model is a parameter) ---

type CustomerState = "satisfied" | "neutral" | "dissatisfied" | "angry";
type ServiceQuality = "ok" | "unsatisfactory" | "no_agent_reply";
interface Grade { customer_state: CustomerState; service_quality: ServiceQuality; flagged: boolean; reason: string; model: string; ms: number }

async function grade(model: string, ticket: FdTicket, conversations: FdConversation[], replyBody: string): Promise<Grade> {
  const start = Date.now();
  const requesterName = ticket.requester?.name || "";
  const requesterEmail = ticket.requester?.email || "unknown";
  const fromLine = requesterName ? `${requesterName} <${requesterEmail}>` : requesterEmail;
  const cleanText = (s: string) => s.replace(/\[image:[^\]]*\]/g, "").replace(/\n{3,}/g, "\n\n").trim();

  const lines: string[] = [];
  lines.push(`--- Original message | ${ticket.created_at} ---\nFrom: ${fromLine}\nSubject: ${ticket.subject}\n\n${cleanText(ticket.description_text || "")}`);
  for (const c of conversations || []) {
    const dir = c.incoming ? "Incoming (customer)" : "Outgoing (agent)";
    const vis = c.private ? " [private note]" : "";
    lines.push(`--- ${dir}${vis} | ${c.created_at} ---\n${cleanText(c.body_text || c.body || "")}`);
  }

  const replyClause = replyBody
    ? `The most recent agent reply on this ticket (in the last 24h):\n"""\n${replyBody}\n"""\n`
    : `(There is no agent reply yet — the customer is waiting.)\n`;

  const userMsg = `You are screening a Swarajya / Kovai Media support ticket for the editor. The editor only wants to see tickets where EITHER (a) the customer expresses anger or dissatisfaction, OR (b) you judge the most recent service response was unsatisfactory. Ignore minor style/tone issues — the goal is real customer-experience problems, not style enforcement.

Ticket #${ticket.id}
Subject: ${ticket.subject}
Customer: ${fromLine}

Full thread (chronological):
${lines.join("\n\n")}

${replyClause}
Output ONLY a JSON object on a single line, no markdown:
{"customer_state": "satisfied" | "neutral" | "dissatisfied" | "angry", "service_quality": "ok" | "unsatisfactory" | "no_agent_reply", "flagged": true | false, "reason": "1-2 sentences explaining what to look at"}

Rules (same as production grader): flag if customer_state is "dissatisfied" or "angry" OR service_quality is "unsatisfactory". Do NOT flag style/tone nits. Be honest but precise.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: RESPONSE_GUIDELINES,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  const ms = Date.now() - start;

  if (!resp.ok) {
    return { customer_state: "neutral", service_quality: "ok", flagged: false, reason: `[${model} error: ${resp.status}]`, model, ms };
  }
  const data = (await resp.json()) as { content: { type: string; text: string }[] };
  const text = data.content.find((c) => c.type === "text")?.text || "{}";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { customer_state: "neutral", service_quality: "ok", flagged: false, reason: "[parse fail]", model, ms };
  try {
    const p = JSON.parse(m[0]);
    const cs: CustomerState = (p.customer_state === "angry" || p.customer_state === "dissatisfied" || p.customer_state === "satisfied") ? p.customer_state : "neutral";
    const sq: ServiceQuality = (p.service_quality === "unsatisfactory" || p.service_quality === "no_agent_reply") ? p.service_quality : "ok";
    const flagged = cs === "angry" || cs === "dissatisfied" || sq === "unsatisfactory";
    return { customer_state: cs, service_quality: sq, flagged, reason: p.reason || "", model, ms };
  } catch {
    return { customer_state: "neutral", service_quality: "ok", flagged: false, reason: "[parse fail]", model, ms };
  }
}

// --- Pull recent tickets with human replies ---

console.log(`Fetching tickets from last 24h (target: ${TICKET_LIMIT} with human replies)...`);
const sinceMs = Date.now() - 24 * 3600 * 1000;
const sinceIso = new Date(sinceMs).toISOString();
const allTickets = await fd<FdTicket[]>(`/api/v2/tickets?updated_since=${encodeURIComponent(sinceIso)}&per_page=100&page=1&order_by=updated_at&order_type=desc&include=requester,description`);
console.log(`  Freshdesk returned ${allTickets.length} tickets`);

interface Candidate { ticket: FdTicket; conversations: FdConversation[]; replyBody: string }
const candidates: Candidate[] = [];
await parallel(allTickets, 5, async (ticket) => {
  if (candidates.length >= TICKET_LIMIT) return;
  try {
    const convs = await fd<FdConversation[]>(`/api/v2/tickets/${ticket.id}/conversations`);
    const replies = (convs || [])
      .filter((c) => !c.incoming && !c.private)
      .filter((c) => new Date(c.created_at).getTime() >= sinceMs);
    const human = replies.filter((c) => {
      const body = (c.body_text || c.body || "").trim();
      return body && !body.startsWith(FORWARD_DRAFTS_AUTO_REPLY_PREFIX);
    });
    if (!human.length) return;
    human.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    candidates.push({ ticket, conversations: convs, replyBody: (human[0].body_text || human[0].body || "").trim() });
  } catch { /* skip */ }
});
console.log(`  Found ${candidates.length} tickets with a human agent reply`);

if (candidates.length === 0) {
  console.log("No tickets to compare. Exiting.");
  process.exit(0);
}

// --- Grade with both models in parallel ---

console.log(`\nGrading each with both ${MODEL_HAIKU} and ${MODEL_SONNET}...`);
interface Pair { ticket_id: number; subject: string; haiku: Grade; sonnet: Grade }
const pairs: Pair[] = [];

await parallel(candidates, 3, async (c) => {
  const [haiku, sonnet] = await Promise.all([
    grade(MODEL_HAIKU, c.ticket, c.conversations, c.replyBody),
    grade(MODEL_SONNET, c.ticket, c.conversations, c.replyBody),
  ]);
  pairs.push({ ticket_id: c.ticket.id, subject: c.ticket.subject, haiku, sonnet });
  process.stdout.write(".");
});
console.log("");

// --- Report ---

const agree = pairs.filter((p) => p.haiku.flagged === p.sonnet.flagged);
const disagree = pairs.filter((p) => p.haiku.flagged !== p.sonnet.flagged);
const stateAgree = pairs.filter((p) => p.haiku.customer_state === p.sonnet.customer_state);
const serviceAgree = pairs.filter((p) => p.haiku.service_quality === p.sonnet.service_quality);

const haikuAvgMs = Math.round(pairs.reduce((sum, p) => sum + p.haiku.ms, 0) / pairs.length);
const sonnetAvgMs = Math.round(pairs.reduce((sum, p) => sum + p.sonnet.ms, 0) / pairs.length);

console.log(`\n=== Summary (${pairs.length} tickets) ===`);
console.log(`Flagged/not agreement: ${agree.length}/${pairs.length} (${Math.round(100 * agree.length / pairs.length)}%)`);
console.log(`customer_state agreement:   ${stateAgree.length}/${pairs.length} (${Math.round(100 * stateAgree.length / pairs.length)}%)`);
console.log(`service_quality agreement:  ${serviceAgree.length}/${pairs.length} (${Math.round(100 * serviceAgree.length / pairs.length)}%)`);
console.log(`\nLatency (avg per grade): Haiku ${haikuAvgMs}ms · Sonnet ${sonnetAvgMs}ms`);

const haikuFlagged = pairs.filter((p) => p.haiku.flagged).length;
const sonnetFlagged = pairs.filter((p) => p.sonnet.flagged).length;
console.log(`\nFlagged counts: Haiku ${haikuFlagged}/${pairs.length}  ·  Sonnet ${sonnetFlagged}/${pairs.length}`);

if (disagree.length > 0) {
  console.log(`\n=== Disagreements on flagged/not (${disagree.length}) ===`);
  for (const p of disagree) {
    const haikuVerdict = `${p.haiku.customer_state}/${p.haiku.service_quality} → ${p.haiku.flagged ? "🚩" : "ok"}`;
    const sonnetVerdict = `${p.sonnet.customer_state}/${p.sonnet.service_quality} → ${p.sonnet.flagged ? "🚩" : "ok"}`;
    console.log(`\n#${p.ticket_id} — ${p.subject.slice(0, 60)}`);
    console.log(`  Haiku:  ${haikuVerdict}`);
    console.log(`          "${p.haiku.reason}"`);
    console.log(`  Sonnet: ${sonnetVerdict}`);
    console.log(`          "${p.sonnet.reason}"`);
  }
}

// Also dump full raw comparison to JSON for later inspection
await Bun.write("./grader-comparison.json", JSON.stringify(pairs, null, 2));
console.log(`\nFull JSON: ./grader-comparison.json`);
