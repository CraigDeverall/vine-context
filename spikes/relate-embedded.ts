// Spike C: does embedded Relate work from a bundled build?
//
// Checks: open a directory store, constraints and indexes, temporal values,
// hybrid search with COMBINE (preview), queryAsync, checkpoint, reopen.
// Run from source:   npx tsx spikes/relate-embedded.ts <dir>
// Run bundled:       node spikes/.out/relate-embedded.js <dir>

// COMBINE is behind a preview gate in Relate 1.0; set it before Relate loads.
process.env.RELATE_PREVIEW = "hybrid-search";
const { Database } = await import("@relate/relate");

const dir = process.argv[2] ?? "./.data/spike-c";
const results: Record<string, unknown> = {};

{
  const db = Database.open(dir);
  const conn = db.connect();
  conn.query("CREATE CONSTRAINT claim_id IF NOT EXISTS FOR (c:Claim) REQUIRE c.id IS UNIQUE");
  conn.query(
    "CREATE VECTOR INDEX claim_embedding IF NOT EXISTS FOR (c:Claim) ON (c.embedding) " +
      "OPTIONS {indexConfig: {`vector.dimensions`: 3, `vector.similarity_function`: 'cosine'}}",
  );
  conn.query("CREATE FULLTEXT INDEX claim_text IF NOT EXISTS FOR (c:Claim) ON EACH [c.text]");

  const claims = [
    { id: "c1", text: "The outage started after the router firmware update", embedding: [1, 0, 0] },
    { id: "c2", text: "The ONT restarts every night at 3am", embedding: [0, 1, 0] },
    { id: "c3", text: "Firmware rollback fixed the router", embedding: [0.9, 0.1, 0] },
  ];
  for (const c of claims) {
    await conn.queryAsync(
      "MERGE (c:Claim {id: $id}) SET c.text = $text, c.embedding = $embedding, " +
        "c.recorded_at = datetime(), c.valid_from = date('2026-11-10')",
      c,
    );
  }
  conn.query("MATCH (a:Claim {id:'c3'}), (b:Claim {id:'c1'}) MERGE (a)-[:SUPPORTS]->(b)");

  results.hybrid = (
    await conn.queryAsync(
      "MATCH (c:Claim) SEARCH c IN (COMBINE (" +
        "VECTOR INDEX claim_embedding FOR $vector LIMIT 5 WEIGHT 1, " +
        "FULLTEXT INDEX claim_text FOR $query LIMIT 5 WEIGHT 1" +
        ") USING WRRF WITH CONSTANT 60 LIMIT 5) SCORE AS score " +
        "RETURN c.id AS id, score ORDER BY score DESC",
      { vector: [1, 0, 0], query: "firmware router" },
    )
  ).rows.map((r) => r.id);

  results.asOf = conn
    .query("MATCH (c:Claim) WHERE c.recorded_at <= datetime() RETURN count(c) AS n")
    .single().n;
  db.checkpoint();
}

{
  // A second open in the same process sees the checkpointed data.
  const db = Database.open(dir, { readOnly: true });
  const r = db.connect().query("MATCH (a)-[:SUPPORTS]->(b) RETURN a.id AS a, b.id AS b").rows;
  results.reopenedReadOnly = r;
}

console.log(JSON.stringify(results));
