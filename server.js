const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({limit:"10mb"}));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const GITHUB_REPO = process.env.GITHUB_REPO;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

const DEBUG_FILE = "/tmp/last_payload.json";

// ── Persistent health data stored in GitHub ──
async function loadHealthData() {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/health_data.json`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }});
    if (!res.ok) return {};
    const data = await res.json();
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  } catch(e) { return {}; }
}

async function saveHealthData(data) {
  try {
    // Get current SHA if file exists
    let sha = null;
    const check = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/health_data.json`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }});
    if (check.ok) { const d = await check.json(); sha = d.sha; }

    const body = { message: "Update health data", content: Buffer.from(JSON.stringify(data)).toString("base64") };
    if (sha) body.sha = sha;

    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/health_data.json`, {
      method: "PUT",
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch(e) { console.error("Save health error:", e); }
}

// ── Parse Health Auto Export v2 ──
function parseHAEPayload(payload) {
  const metrics = payload?.data?.metrics || [];
  const result = {};
  metrics.forEach(metric => {
    const name = metric.name;
    const data = metric.data || [];
    switch(name) {
      case "weight_body_mass":
        const w = data[data.length-1]; if(w) result.weight = w.qty; break;
      case "body_fat_percentage":
        const bf = data[data.length-1]; if(bf) result.bodyFat = bf.qty; break;
      case "body_mass_index":
        const bmi = data[data.length-1]; if(bmi) result.bmi = bmi.qty; break;
      case "step_count":
        result.steps = data.reduce((s,d)=>s+(d.qty||0),0); break;
      case "active_energy":
        result.activeCalories = data.reduce((s,d)=>s+(d.qty||0),0); break;
      case "heart_rate_variability":
        if(data.length>0) result.hrv = data.reduce((s,d)=>s+(d.qty||0),0)/data.length; break;
      case "heart_rate":
        if(data.length>0) result.restingHR = data.reduce((s,d)=>s+(d.Avg||d.qty||0),0)/data.length; break;
      case "sleep_analysis":
        const s = data[0];
        if(s){ result.sleep=s.totalSleep||0; result.sleepDeep=s.deep||0; result.sleepREM=s.rem||0; result.sleepCore=s.core||0; } break;
      case "respiratory_rate":
        if(data.length>0) result.respiratoryRate = data.reduce((s,d)=>s+(d.qty||0),0)/data.length; break;
      case "walking_running_distance":
        result.distance = data.reduce((s,d)=>s+(d.qty||0),0); break;
      case "dietary_protein": result.protein = data.reduce((s,d)=>s+(d.qty||0),0); break;
      case "dietary_carbohydrates": result.carbs = data.reduce((s,d)=>s+(d.qty||0),0); break;
      case "dietary_fat_total": result.fat = data.reduce((s,d)=>s+(d.qty||0),0); break;
      case "dietary_energy": result.calories = data.reduce((s,d)=>s+(d.qty||0),0); break;
    }
  });
  return result;
}

// ── Health webhook ──
app.post("/health", async (req, res) => {
  const payload = req.body;
  const today = new Date().toISOString().split("T")[0];
  try{ fs.writeFileSync(DEBUG_FILE, JSON.stringify(payload,null,2)); }catch(e){}
  const update = parseHAEPayload(payload);
  update.date = today;
  update.lastSync = new Date().toISOString();
  const healthData = await loadHealthData();
  healthData[today] = { ...(healthData[today]||{}), ...update };
  await saveHealthData(healthData);
  res.json({ success:true, date:today, parsed:update });
});

app.post("/debug", (req, res) => {
  try{ fs.writeFileSync(DEBUG_FILE, JSON.stringify(req.body,null,2)); }catch(e){}
  res.json({ success:true, parsed: parseHAEPayload(req.body) });
});

app.get("/debug", (req, res) => {
  try{ res.json(JSON.parse(fs.readFileSync(DEBUG_FILE,"utf8"))); }
  catch(e){ res.json({ message:"No debug data yet" }); }
});

app.get("/health", async (req, res) => {
  const healthData = await loadHealthData();
  const today = new Date().toISOString().split("T")[0];
  const last7 = {};
  for(let i=0;i<7;i++){
    const d=new Date(); d.setDate(d.getDate()-i);
    const key=d.toISOString().split("T")[0];
    if(healthData[key]) last7[key]=healthData[key];
  }
  res.json({ today:healthData[today]||{}, history:last7 });
});

app.post("/health/manual", async (req, res) => {
  const { password, data } = req.body;
  if(password!==ADMIN_PASSWORD) return res.status(401).json({ error:"Wrong password" });
  const today = new Date().toISOString().split("T")[0];
  const healthData = await loadHealthData();
  healthData[today] = { ...(healthData[today]||{}), ...data, date:today };
  await saveHealthData(healthData);
  res.json({ success:true });
});

// ── Schedule update ──
async function getFile(filename){
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filename}`,
    { headers:{ Authorization:`token ${GITHUB_TOKEN}`, Accept:"application/vnd.github.v3+json" }});
  const data = await res.json();
  return { content:Buffer.from(data.content,"base64").toString("utf8"), sha:data.sha };
}

async function updateFile(filename, content, sha, message){
  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filename}`,{
    method:"PUT",
    headers:{ Authorization:`token ${GITHUB_TOKEN}`, Accept:"application/vnd.github.v3+json", "Content-Type":"application/json" },
    body:JSON.stringify({ message, content:Buffer.from(content).toString("base64"), sha }),
  });
}

app.post("/update", async (req, res) => {
  const { password, instruction } = req.body;
  if(password!==ADMIN_PASSWORD) return res.status(401).json({ error:"Wrong password" });
  try{
    const { content, sha } = await getFile("index.html");
    const message = await client.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:16000,
      messages:[{ role:"user", content:`You are editing a weekly schedule web app. Here is the COMPLETE current index.html file:\n\n${content}\n\nInstruction: ${instruction}\n\nRules:\n1. Return the COMPLETE updated index.html file - do not truncate or shorten it\n2. Only change what the instruction asks\n3. Keep every single other line exactly as is\n4. No explanation, no markdown, just the raw complete HTML` }]
    });
    let updatedContent = message.content[0].text;
    updatedContent = updatedContent.replace(/^```html\n?/i, "").replace(/^```\n?/i, "").replace(/\n?```$/i, "").trim();
    if(!updatedContent.includes("<!DOCTYPE") && !updatedContent.includes("<html")) {
      return res.status(500).json({ error:"AI returned invalid HTML" });
    }
    await updateFile("index.html", updatedContent, sha, `Update: ${instruction}`);
    res.json({ success:true, message:"Schedule updated! Changes live in ~30 seconds." });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.get("/", (req, res) => res.send("Schedule API running"));
app.listen(process.env.PORT||3000, () => console.log("Server running"));
