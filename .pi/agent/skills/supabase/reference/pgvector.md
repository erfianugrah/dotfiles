# pgvector (semantic search)

Read when adding embeddings to a Supabase project. Index-type guidance lives
in the `supabase-postgres-best-practices` skill.

```sql
-- One-time: enable extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Table for embeddings (OpenAI text-embedding-3-small = 1536 dims)
CREATE TABLE documents (
  id        bigserial PRIMARY KEY,
  content   text,
  embedding vector(1536),
  user_id   uuid REFERENCES auth.users
);

-- HNSW index (better recall than IVFFlat for most queries)
CREATE INDEX ON documents USING hnsw (embedding vector_cosine_ops);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_docs" ON documents FOR ALL USING (user_id = (SELECT auth.uid()));
```

**Query** (RPC for vector args; supabase-js cannot bind `vector` natively):

```sql
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_count int DEFAULT 5
) RETURNS TABLE (id bigint, content text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT
    d.id, d.content,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  WHERE d.user_id = auth.uid()
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
$$;
```

```ts
// Client
const { data } = await supabase.rpc('match_documents', {
  query_embedding: embedding,    // number[] of length 1536
  match_count: 10
})
```

**Index choice**:
- **HNSW** - better recall, slower build, more memory. Default.
- **IVFFlat** - faster build, lower memory, lower recall on small datasets.
  Use when the corpus is under ~100k rows or memory-constrained.
