const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(cors());
app.use(express.json());

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. "username/my-schedule"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Get current file from GitHub
async function getFile() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/index.html`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
  );
  const data = await res.json();
  return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
}

// Push updated file to GitHub
async function updateFile(content, sha, message) {
  await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/index.html`,
    {
      method: "PUT",
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: Buffer.from(content).toString("base64"), sha }),
    }
  );
}

// Admin update endpoint
app.post("/update", async (req, res) => {
  const { password, instruction } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Wrong password" });
  }

  try {
    // Get current file
    const { content, sha } = await getFile();

    // Ask Claude to make the change
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      messages: [{
        role: "user",
        content: `You are editing a weekly schedule app. Here is the current index.html file:\n\n${content}\n\nInstruction: ${instruction}\n\nReturn ONLY the complete updated index.html file with the change applied. No explanation, no markdown, just the raw HTML.`
      }]
    });

    const updatedContent = message.content[0].text;

    // Push to GitHub
    await updateFile(updatedContent, sha, `Update: ${instruction}`);

    res.json({ success: true, message: "Schedule updated! Changes live in ~30 seconds." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => res.send("Schedule API running"));

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
