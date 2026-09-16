import { basename } from "node:path";

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren't", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down", "during",
  "each", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her", "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's",
  "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it", "it's", "its", "itself",
  "let's", "me", "more", "most", "mustn't", "my", "myself",
  "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own",
  "same", "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such",
  "than", "that", "that's", "the", "their", "theirs", "them", "themselves", "then", "there", "there's", "these", "they", "they'd", "they'll", "they're", "they've", "this", "those", "through", "to", "too",
  "under", "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were", "weren't", "what", "what's", "when", "when's", "where", "where's", "which", "while", "who", "who's", "whom", "why", "why's", "with", "won't", "would", "wouldn't",
  "you", "you'd", "you'll", "you're", "you've", "your", "yours", "yourself", "yourselves"
]);

/**
 * Extracts significant search keywords from a query string, filtering common stop words.
 */
function extractKeywords(query) {
  const normalized = query.toLowerCase().replace(/[^a-z0-9_\-\s]/g, " ");
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 1);
  const keywords = tokens.filter((t) => !STOP_WORDS.has(t));
  return keywords.length > 0 ? keywords : tokens;
}

/**
 * Executes a production-grade Hybrid Search combining:
 * 1. Asymmetric Dense Vector Similarity (LanceDB + nomic-embed-text)
 * 2. Lexical / Keyword Matching (Exact phrase, filename boost, term frequency)
 * 3. Reciprocal Rank Fusion (RRF) with Deduplication
 *
 * @param {string} query - User search query
 * @param {number} topK - Number of results to return (1-50)
 * @returns {Promise<Array<Object>>} Ranked document chunks
 */
export async function searchDocuments(query, topK = 5) {
  if (!query || !query.trim()) {
    throw new Error("Search query cannot be empty");
  }

  if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
    throw new Error("topK must be an integer between 1 and 50");
  }

  const [{ default: db }, { embedQuery }] = await Promise.all([
    import("./database.js"),
    import("./embedder.js"),
  ]);

  const tableNames = await db.tableNames();
  if (!tableNames.includes("documents")) {
    return [];
  }

  const table = await db.openTable("documents");
  const rowCount = await table.countRows();
  if (rowCount === 0) {
    return [];
  }

  // 1. Generate query embedding with search_query task prefix
  const queryEmbedding = await embedQuery(query);

  // 2. Retrieve vector candidate pool
  const candidateLimit = Math.min(Math.max(topK * 4, 25), rowCount);
  const vectorCandidates = await table
    .search(queryEmbedding)
    .limit(candidateLimit)
    .toArray();

  const vectorDistanceMap = new Map();
  const vectorRankMap = new Map();
  vectorCandidates.forEach((r, idx) => {
    vectorDistanceMap.set(r.id, r._distance);
    vectorRankMap.set(r.id, idx + 1);
  });

  // 3. Extract keywords for lexical search
  const queryTrimmed = query.trim();
  const queryLower = queryTrimmed.toLowerCase();
  const keywords = extractKeywords(queryLower);

  // 4. Retrieve corpus records for lexical scoring
  // For standard local RAG collections, table.query().toArray() is fast and guarantees 100% keyword recall
  const allRows = await table.query().toArray();

  const scoredRecords = allRows.map((r) => {
    const textLower = (r.text || "").toLowerCase();
    const fileName = basename(r.sourceFile || "").toLowerCase();

    let lexicalScore = 0;
    const matchedKeywords = [];

    // Exact phrase match bonus
    if (queryTrimmed.length > 3 && textLower.includes(queryLower)) {
      lexicalScore += 12.0;
      matchedKeywords.push(`phrase:"${queryTrimmed}"`);
    }

    for (const kw of keywords) {
      // Filename match bonus (e.g. searching "prasanna" directly matches "prasanna.md")
      if (fileName.includes(kw)) {
        lexicalScore += 6.0;
        matchedKeywords.push(`file:${kw}`);
      }

      // Word boundary match in text
      const wordRegex = new RegExp(`\\b${kw}\\b`, "g");
      const occurrences = (textLower.match(wordRegex) || []).length;
      if (occurrences > 0) {
        lexicalScore += 3.0 + Math.log(1 + occurrences);
        matchedKeywords.push(`${kw}(${occurrences})`);
      } else if (textLower.includes(kw)) {
        lexicalScore += 1.0;
        matchedKeywords.push(`sub:${kw}`);
      }
    }

    return {
      row: r,
      lexicalScore,
      matchedKeywords,
    };
  });

  // Sort by lexical score to determine lexical ranks
  scoredRecords.sort((a, b) => b.lexicalScore - a.lexicalScore);
  const lexicalRankMap = new Map();
  scoredRecords.forEach((item, idx) => {
    if (item.lexicalScore > 0) {
      lexicalRankMap.set(item.row.id, idx + 1);
    }
  });

  // 5. Reciprocal Rank Fusion (RRF) & Hybrid Score Computation
  const RRF_K = 60;
  const WEIGHT_VECTOR = 0.45;
  const WEIGHT_LEXICAL = 0.55;

  const rankedPool = scoredRecords.map((item) => {
    const r = item.row;
    const vRank = vectorRankMap.get(r.id) || (candidateLimit + 50);
    const lRank = lexicalRankMap.get(r.id) || (allRows.length + 50);

    const rrfScore =
      (WEIGHT_VECTOR / (RRF_K + vRank)) +
      (WEIGHT_LEXICAL / (RRF_K + lRank));

    const distance = vectorDistanceMap.get(r.id) ?? 1.5;

    // Normalized hybrid confidence score (0.0 to 1.0)
    const normalizedVectorSim = Math.max(0, 1 - distance / 1.5);
    const normalizedLexicalSim = item.lexicalScore > 0 ? Math.min(1.0, 0.4 + item.lexicalScore * 0.1) : 0;
    const score = Math.round(((normalizedVectorSim * 0.4) + (normalizedLexicalSim * 0.6)) * 100) / 100;

    let matchType = "semantic";
    if (item.lexicalScore > 0 && vectorDistanceMap.has(r.id)) {
      matchType = "hybrid";
    } else if (item.lexicalScore > 0) {
      matchType = "keyword";
    }

    return {
      id: r.id,
      text: r.text,
      sourceFile: r.sourceFile,
      chunkIndex: r.chunkIndex,
      _distance: distance,
      score,
      rrfScore,
      matchType,
      keywordMatches: item.matchedKeywords,
    };
  });

  // Sort descending by RRF score, then confidence score
  rankedPool.sort((a, b) => b.rrfScore - a.rrfScore || b.score - a.score);

  // 6. Deduplicate by filename + chunkIndex (e.g. avoids duplicate /app/docs vs local host copies)
  const dedupedResults = [];
  const seenKeys = new Set();

  for (const item of rankedPool) {
    const fileName = basename(item.sourceFile || "");
    const dedupKey = `${fileName}:${item.chunkIndex || 0}`;

    if (!seenKeys.has(dedupKey)) {
      seenKeys.add(dedupKey);
      dedupedResults.push(item);
    }

    if (dedupedResults.length >= topK) {
      break;
    }
  }

  // 7. Retrieve Knowledge Graph context (multi-hop graph traversal in pure JS)
  try {
    const { findConnectedSubgraph } = await import("./graph.js");
    const graphFacts = await findConnectedSubgraph(keywords, 2, 25);

    if (graphFacts.length > 0) {
      dedupedResults.graphContext = graphFacts;
      if (dedupedResults[0]) {
        dedupedResults[0].graphFacts = graphFacts.map((f) => f.formatted);
      }
    }
  } catch {}

  return dedupedResults;
}
