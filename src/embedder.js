export async function embedText(text) {
  const response = await fetch("http://localhost:11434/api/embed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "nomic-embed-text",
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }

  const data = await response.json();

  return data.embeddings[0];
}