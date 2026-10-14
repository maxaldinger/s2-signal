// Text embeddings for semantic search over researched accounts.
//
// OpenAI text-embedding-3-small (1536 dims). Its vectors are unit-length, so
// SingleStore's DOT_PRODUCT (<*>) on them is cosine similarity. The provider
// lives behind embed() only: swapping it (Voyage, SingleStore EMBED_TEXT, a
// local model) means changing this file and EMBEDDING_DIM, then re-running
// `npm run db:embed-briefs`.

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1536;

export function embeddingsConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/** Embed up to ~100 texts per call. Throws with a readable message on failure. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is not set, so semantic search is unavailable.");
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts.slice(i, i + 100).map((t) => t.slice(0, 24_000)) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
      throw new Error(res.status === 401 ? "OpenAI API key invalid or revoked." : `OpenAI embeddings ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    out.push(...data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

/** SingleStore accepts a JSON array literal cast to VECTOR. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(7)).join(",")}]`;
}
