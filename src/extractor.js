import { basename } from "node:path";

const KNOWN_TECHNOLOGIES = [
  "Node.js", "Express.js", "React", "MongoDB", "REST API", "Redis", "BullMQ",
  "Chokidar", "Ollama", "LanceDB", "Model Context Protocol", "MCP", "Docker",
  "Prometheus", "Grafana", "MERN", "Machine Learning", "Python", "JavaScript",
  "TypeScript", "HTML", "CSS", "TailwindCSS", "PostgreSQL", "SQLite", "GraphQL",
  "KùzuDB", "Neo4j", "Babel", "Prettier", "Fabric.js", "Next.js", "Vite"
];

function toEntityId(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Extracts structured entities and relationships from Markdown documentation.
 *
 * @param {string} text - Raw Markdown content
 * @param {string} filePath - Path to source document
 * @returns {Object} Extracted { entities, relations }
 */
export function extractGraphData(text, filePath) {
  const fileName = basename(filePath || "document.md");
  const entitiesMap = new Map();
  const relations = [];

  function addEntity(name, type) {
    if (!name || name.trim().length < 2) return null;
    const id = toEntityId(name);
    if (!entitiesMap.has(id)) {
      entitiesMap.set(id, {
        id,
        name: name.trim(),
        type,
        sourceFile: filePath,
      });
    }
    return id;
  }

  function addRelation(fromId, toId, relation) {
    if (!fromId || !toId || fromId === toId) return;
    relations.push({ fromId, toId, relation });
  }

  // 1. Create Document root entity
  const docTitle = fileName.replace(/\.md$/i, "");
  const docEntityId = addEntity(docTitle, "Document");

  const lines = text.split("\n");
  let mainSubjectId = null;
  let currentParentId = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // H1 Heading
    if (line.startsWith("# ")) {
      const headingText = line.replace(/^#+\s*/, "").trim();
      const personMatch = headingText.match(/(?:about me|profile|author|bio)\s*[-—–:]\s*(.+)/i);

      if (personMatch) {
        mainSubjectId = addEntity(personMatch[1], "Person");
        addRelation(mainSubjectId, docEntityId, "DESCRIBED_IN");
      } else {
        mainSubjectId = addEntity(headingText, "Topic");
        addRelation(mainSubjectId, docEntityId, "DESCRIBED_IN");
      }
      currentParentId = mainSubjectId;
      continue;
    }

    // H2 Heading
    if (line.startsWith("## ")) {
      const h2Text = line.replace(/^##\s*/, "").replace(/^#+\s*/, "").trim();
      const h2Id = addEntity(h2Text, "Category");
      if (mainSubjectId) {
        addRelation(mainSubjectId, h2Id, "HAS_SECTION");
      }
      currentParentId = h2Id;
      continue;
    }

    // H3 Heading (often specific projects or sub-topics)
    if (line.startsWith("### ")) {
      const h3Text = line.replace(/^###\s*/, "").trim();
      const projId = addEntity(h3Text, "Project");

      if (mainSubjectId) {
        addRelation(mainSubjectId, projId, "BUILT");
      } else if (currentParentId) {
        addRelation(currentParentId, projId, "CONTAINS");
      }
      currentParentId = projId;
      continue;
    }

    // Check technologies and keywords in bullets or paragraphs
    for (const tech of KNOWN_TECHNOLOGIES) {
      const regex = new RegExp(`\\b${tech.replace(".", "\\.")}\\b`, "i");
      if (regex.test(line)) {
        const techId = addEntity(tech, "Technology");
        if (currentParentId) {
          const relation = currentParentId === mainSubjectId ? "SKILLED_IN" : "USES";
          addRelation(currentParentId, techId, relation);
        }
      }
    }
  }

  // Deduplicate relations
  const seenRelations = new Set();
  const uniqueRelations = [];

  for (const rel of relations) {
    const key = `${rel.fromId}:${rel.relation}:${rel.toId}`;
    if (!seenRelations.has(key)) {
      seenRelations.add(key);
      uniqueRelations.push(rel);
    }
  }

  return {
    entities: Array.from(entitiesMap.values()),
    relations: uniqueRelations,
  };
}
