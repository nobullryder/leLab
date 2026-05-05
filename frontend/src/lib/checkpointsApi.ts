type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

export interface JobCheckpoint {
  step: number;
  source: "local" | "hub";
  ref: string;
}

export async function listJobCheckpoints(
  baseUrl: string,
  fetcher: Fetcher,
  jobId: string,
): Promise<JobCheckpoint[]> {
  const r = await fetcher(`${baseUrl}/jobs/${jobId}/checkpoints`);
  if (!r.ok) {
    throw new Error(`List checkpoints failed: ${r.status}`);
  }
  const body = await r.json();
  return body.checkpoints;
}
