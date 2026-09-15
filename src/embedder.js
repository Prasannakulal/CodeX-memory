import config from "./config.js";

export async function embedText(text, options = {}) {
  const modelName = config.ollama.model || "";
  const isNomic = modelName.toLowerCase().includes("nomic");

  let inputText = text;
  const taskType = typeof options === "string" ? options : options?.taskType;

  if (isNomic && taskType) {
    const prefix = `${taskType}: `;
    if (!inputText.startsWith("search_query:") && !inputText.startsWith("search_document:")) {
      inputText = `${prefix}${inputText}`;
    }
  }

  const url = `${config.ollama.baseUrl.replace(/\/+$/, "")}/api/embed`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.ollama.model,
      input: inputText,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }

  const data = await response.json();

  return data.embeddings[0];
}

export async function embedQuery(text) {
  return embedText(text, { taskType: "search_query" });
}

export async function embedDocument(text) {
  return embedText(text, { taskType: "search_document" });
}