// Backs generate_images/get_images: generate_images kicks off generation in the
// background and returns a job id immediately; get_images polls this store. This
// exists because a batch that waits for every image before replying can run long
// enough (each image is 30-90s incl. verification) to exceed the MCP client's own
// per-tool-call wait limit — returning instantly and polling sidesteps that entirely.
export interface BulkJobItem {
  prompt: string;
  status: "pending" | "done" | "error";
  url?: string;
  verified?: boolean;
  rounds?: number;
  problems?: string[];
  error?: string;
}

interface BulkJob {
  items: BulkJobItem[];
  createdAt: number;
}

const jobs = new Map<string, BulkJob>();
const MAX_JOBS = 50;
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function prune(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    if (!oldest) break;
    jobs.delete(oldest);
  }
}

export function createBulkJob(prompts: string[]): string {
  prune();
  const id = crypto.randomUUID();
  jobs.set(id, {
    items: prompts.map((prompt) => ({ prompt, status: "pending" })),
    createdAt: Date.now(),
  });
  return id;
}

export function setBulkJobItem(jobId: string, index: number, item: BulkJobItem): void {
  jobs.get(jobId)?.items.splice(index, 1, item);
}

export function getBulkJob(jobId: string): BulkJobItem[] | null {
  return jobs.get(jobId)?.items || null;
}
