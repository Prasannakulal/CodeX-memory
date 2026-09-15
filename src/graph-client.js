/**
 * graph-client.js — HTTP client for the KùzuDB Graph Service
 *
 * Used by search.js and server.js to query the graph service.
 * Falls back gracefully if the graph service is unavailable.
 */

const GRAPH_SERVICE_URL = `http://127.0.0.1:${process.env.GRAPH_SERVICE_PORT || 3002}`;
const DEFAULT_TIMEOUT_MS = 2000; // Don't slow down MCP responses

/**
 * Check if graph service is reachable.
 */
export async function isGraphServiceUp() {
  try {
    const res = await fetch(`${GRAPH_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Query the knowledge graph for facts related to the given keywords.
 *
 * @param {string[]} keywords   - Terms extracted from the user's query
 * @param {number}   hops       - Traversal depth (1–3)
 * @param {number}   limit      - Max results
 * @param {number}   timeoutMs  - Abort if service takes longer
 * @returns {Promise<Array>}    - Array of { from, relation, to, formatted }
 */
export async function queryGraph(keywords = [], hops = 2, limit = 25, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!keywords.length) return [];

  try {
    const res = await fetch(`${GRAPH_SERVICE_URL}/query`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ keywords, hops, limit }),
      signal:  AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch {
    // Service unavailable or timed out — silently return empty
    return [];
  }
}

/**
 * Get entity/relation counts from the graph service.
 */
export async function getGraphStats() {
  try {
    const res = await fetch(`${GRAPH_SERVICE_URL}/stats`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
