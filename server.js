const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({limit:"10mb"}));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const GITHUB_REPO = process.env.GITHUB_REPO;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Persistent storage using file system ──
const DATA_FILE = "/tmp/health_data.json";
const DEBUG_FILE = "/tmp/last_payload.json";

function loadHealthData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch(e) { return {}; }
}
function saveHealthData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch(e) {}
}

// ── Debug endpoint — see exactly what Health Auto Export sends ──
app.post("/debug", (req, res) => {
  const payload = req.body;
  try { fs.writeFileSync(DEBUG_FILE, JSON.stringify(payload, null, 2)); } catch(e) {}
  console.log("DEBUG payload received:", JSON.stringify(payload, null, 2).substring(0, 500));
  res.json({ success: true, received: payload });
});

app.get("/debug", (req, res) => {
  try {
    const payload = JSON.parse(fs.readFileSync(DEBUG_FILE, "utf8"));
    res.json(payload);
  } catch(e) { res.json({ message: "No debug data yet — POST to /debug first" }); }
});

// ── Health data webhook ──
app.post("/health", (req, res) => {
  const payload = req.body;
  const today = new Date().toISOString().split("T")[0];

  // Save raw payload for debugging
  try { fs.writeFileSync(DEBUG_FILE, JSON.stringify(payload, null, 2)); } catch(e) {}
  console.log("Health payload keys:", Object.keys(payload));

  // Health Auto Export sends data in various formats — handle all of them
  let metrics = {};

  // Format 1: flat object with metric names as keys
  // Format 2: { data: { metrics: [...] } }
  // Format 3: { metrics: [...] } array format
  // Format 4: nested object with HKQuantityType keys

  const data = payload.data || payload;

  // If it's an array of metrics
  if (Array.isArray(data)) {
    data.forEach(item => {
      const name = item.name || item.type || "";
      const val = item.qty || item.value || item.sum || item.avg || null;
      if (name && val !== null) metrics[name.toLowerCase().replace(/\s+/g,"_")] = val;
    });
  }
  // If metrics is an array inside data
  else if (data.metrics && Array.isArray(data.metrics)) {
    data.metrics.forEach(item => {
      const name = item.name || item.type || "";
      const val = item.qty || item.value || item.sum || item.avg || null;
      if (name && val !== null) metrics[name.toLowerCase().replace(/\s+/g,"_")] = val;
    });
  }
  // Flat object
  else {
    metrics = data;
  }

  console.log("Parsed metrics keys:", Object.keys(metrics).join(", "));

  const update = {
    date: today,
    weight: extract(metrics, ["body_mass","weight","bodymass","body mass","hkquantitytypeidentifierbodymass"]),
    bodyFat: extract(metrics, ["body_fat_percentage","bodyfatpercentage","body fat percentage","hkquantitytypeidentifierbodyfatpercentage"]),
    steps: extract(metrics, ["step_count","steps","stepcount","step count","hkquantitytypeidentifierstepcount"]),
    sleep: extract(metrics, ["sleep_analysis","sleep","asleep","sleepanalysis","hkcategorytypeidentifiersleepanalysis","sleep duration","time in bed"]),
    hrv: extract(metrics, ["heart_rate_variability_sdnn","hrv","heartratevariabilitysdnn","heart rate variability","hkquantitytypeidentifierheartratevariabilitysdnn"]),
    restingHR: extract(metrics, ["resting_heart_rate","restingheartrate","resting heart rate","hkquantitytypeidentifierrestingheartrate"]),
    protein: extract(metrics, ["dietary_protein","protein","dietaryprotein","hkquantitytypeidentifierdietaryprotein"]),
    carbs: extract(metrics, ["dietary_carbohydrates","carbs","carbohydrates","dietarycarbohydrates","hkquantitytypeidentifierdietarycarbohydrates"]),
    fat: extract(metrics, ["dietary_fat_total","fat","dietaryfat","total fat","hkquantitytypeidentifierdietaryfattotal"]),
    calories: extract(metrics, ["dietary_energy_consumed","calories","dietaryenergy","dietary energy","hkquantitytypeidentifierdietaryenergyconsumed"]),
    activeCalories: extract(metrics, ["active_energy_burned","active_calories","activecalories","active energy","hkquantitytypeidentifieractiveenergyburned"]),
  };

  console.log("Extracted update:", JSON.stringify(update));

  const healthData = loadHealthData();
  healthData[today] = { ...(healthData[today] || {}), ...update };
  saveHealthData(healthData);

  res.json({ success: true, date: today, parsed: update });
});

function extract(data, keys) {
  const lowerData = {};
  Object.keys(data).forEach(k => { lowerData[k.toLowerCase().replace(/[\s-]/g,"_")] = data[k]; });

  for (const key of keys) {
    const val = lowerData[key] || data[key];
    if (val !== undefined && val !== null) {
      if (typeof val === "object") {
        const v = val.qty ?? val.value ?? val.sum ?? val.avg ?? val.min ?? null;
        if (v !== null) return parseFloat(v);
      }
      if (typeof val === "number") return val;
      if (typeof val === "string" && !isNaN(parseFloat(val))) return parseFloat(val);
    }
  }
  return null;
}

// ── Get health data ──
app.get("/health", (req, res) => {
  const healthData = loadHealthData();
  const today = new Date().toISOString().split("T")[0];
  const last7 = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().split("T")[0];
    if (healthData[key]) last7[key] = healthData[key];
  }
  res.json({ today: healthData[today] || {}, history: last7 });
});

// ── Manual entry ──
app.post("/health/manual", (req, res) => {
  const { password, data } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong password" });
  const today = new Date().toISOString().split("T")[0];
  const healthData = loadHealthData();
  healthData[today] = { ...(healthData[today] || {}), ...data, date: today };
  saveHealthData(healthData);
  res.json({ success: true });
});

// ── Schedule update ──
async function getFile() {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/index.html`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } });
  const data = await res.json();
  return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
}

async function updateFile(content, sha, message) {
  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/index.html`, {
    method: "PUT",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: Buffer.from(content).toString("base64"), sha }),
  });
}

app.post("/update", async (req, res) => {
  const { password, instruction } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong password" });
  try {
    const { content, sha } = await getFile();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 8000,
      messages: [{ role: "user", content: `You are editing a weekly schedule app. Here is the current index.html file:\n\n${content}\n\nInstruction: ${instruction}\n\nReturn ONLY the complete updated index.html file with the change applied. No explanation, no markdown, just the raw HTML.` }]
    });
    await updateFile(message.content[0].text, sha, `Update: ${instruction}`);
    res.json({ success: true, message: "Schedule updated! Changes live in ~30 seconds." });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.send("Schedule API running"));
app.listen(process.env.PORT || 3000, () => console.log("Server running"));
