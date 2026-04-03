const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({limit:"50mb"}));
app.use(express.urlencoded({limit:"50mb", extended:true}));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const GITHUB_REPO = process.env.GITHUB_REPO;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

const DEBUG_FILE = "/tmp/last_payload.json";

// ── Supabase health data (persistent) ──
async function loadHealthData() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/health_data?select=*`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      }
    });
    const rows = await res.json();
    const data = {};
    if (Array.isArray(rows)) {
      rows.forEach(row => { data[row.date] = row.data; });
    }
    return data;
  } catch(e) {
    console.error("Supabase load error:", e);
    return {};
  }
}

async function saveHealthDay(date, dayData) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/health_data`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify({ date, data: dayData })
    });
  } catch(e) {
    console.error("Supabase save error:", e);
  }
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
        const sl = data[0];
        if(sl){ result.sleep=sl.totalSleep||0; result.sleepDeep=sl.deep||0; result.sleepREM=sl.rem||0; result.sleepCore=sl.core||0; result.sleepAwake=sl.awake||0; } break;
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
  const merged = { ...(healthData[today]||{}), ...update };
  await saveHealthDay(today, merged);
  res.json({ success:true, date:today, parsed:update });
});

app.post("/debug", async (req, res) => {
  try{ fs.writeFileSync(DEBUG_FILE, JSON.stringify(req.body,null,2)); }catch(e){}
  const parsed = parseHAEPayload(req.body);
  res.json({ success:true, parsed });
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
  const merged = { ...(healthData[today]||{}), ...data, date:today };
  await saveHealthDay(today, merged);
  res.json({ success:true });
});


// ── User Data (persistent app data) ──
async function setupUserDataTable(){
  // Create table if it doesn't exist
  try{
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec`, {
      method:'POST',
      headers:{ apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ query: `CREATE TABLE IF NOT EXISTS user_data (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())` })
    });
  }catch(e){ /* Table may already exist */ }
}

async function getUserData(key){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_data?key=eq.${encodeURIComponent(key)}&select=value`, {
      headers:{ apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}` }
    });
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0].value : null;
  }catch(e){ return null; }
}

async function setUserData(key, value){
  try{
    await fetch(`${SUPABASE_URL}/rest/v1/user_data`, {
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}`,
        'Content-Type':'application/json',
        'Prefer':'resolution=merge-duplicates'
      },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
    });
  }catch(e){ console.error('setUserData error:', e); }
}

// GET /userdata/:key
app.get('/userdata/:key', async (req, res) => {
  const value = await getUserData(req.params.key);
  res.json({ value });
});

// POST /userdata/:key
app.post('/userdata/:key', async (req, res) => {
  const { value } = req.body;
  if(value === undefined) return res.status(400).json({ error: 'Missing value' });
  await setUserData(req.params.key, value);
  res.json({ success: true });
});


// ── AI Logging endpoint ──
app.post('/ai-log', async (req, res) => {
  const { system, input } = req.body;
  if(!input) return res.status(400).json({ error: 'Missing input' });
  try{
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: system,
      messages: [{ role: 'user', content: input }]
    });
    const text = message.content[0].text;
    res.json({ text });
  }catch(e){
    console.error('AI log error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Schedule update (only modifies SCHED data, never touches HTML) ──
async function getFile(){
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/index.html`,
    { headers:{ Authorization:`token ${GITHUB_TOKEN}`, Accept:"application/vnd.github.v3+json" }});
  const data = await res.json();
  return { content:Buffer.from(data.content,"base64").toString("utf8"), sha:data.sha };
}

async function updateFile(content, sha, message){
  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/index.html`,{
    method:"PUT",
    headers:{ Authorization:`token ${GITHUB_TOKEN}`, Accept:"application/vnd.github.v3+json", "Content-Type":"application/json" },
    body:JSON.stringify({ message, content:Buffer.from(content).toString("base64"), sha }),
  });
}

app.post("/update", async (req, res) => {
  const { password, instruction } = req.body;
  if(password!==ADMIN_PASSWORD) return res.status(401).json({ error:"Wrong password" });
  try{
    const { content, sha } = await getFile();
    const schedMatch = content.match(/const SCHED=(\{[^\n]*\n(?:  \w+:\{[^\n]*\},?\n)*\});/);
    if(!schedMatch) return res.status(500).json({ error:"Could not find schedule data" });
    const currentSched = schedMatch[1];

    const message = await client.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:8000,
      messages:[{ role:"user", content:`You are editing a weekly schedule object. Here is the current schedule:\n\n${currentSched}\n\nInstruction: ${instruction}\n\nRules:\n1. Return ONLY the updated JavaScript object starting with { and ending with }\n2. Keep exact format: day names as keys, time strings "8:00 AM" as keys, task names as string values\n3. Only change what the instruction asks\n4. No explanation, no markdown, no variable name, just the raw { } object` }]
    });

    let newSched = message.content[0].text.trim();
    newSched = newSched.replace(/^```[a-z]*\n?/i,"").replace(/\n?```$/,"").trim();
    newSched = newSched.replace(/^const SCHED\s*=\s*/,"").replace(/;$/,"").trim();

    if(!newSched.startsWith("{") || !newSched.includes("Monday")) {
      return res.status(500).json({ error:"AI returned invalid schedule — please try again" });
    }

    const updatedContent = content.replace(
      /const SCHED=\{[^\n]*\n(?:  \w+:\{[^\n]*\},?\n)*\};/,
      `const SCHED=${newSched};`
    );

    if(updatedContent === content) {
      return res.status(500).json({ error:"Schedule update failed — please try again" });
    }

    await updateFile(updatedContent, sha, `Schedule update: ${instruction}`);
    res.json({ success:true, message:"Schedule updated! Refresh your app in 30 seconds." });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

setupUserDataTable();
app.get("/", (req, res) => res.send("Schedule API running"));
app.listen(process.env.PORT||3000, () => console.log("Server running"));
