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

const DATA_FILE = "/tmp/health_data.json";
const DEBUG_FILE = "/tmp/last_payload.json";

function loadHealthData(){ try{ return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }catch(e){ return {}; } }
function saveHealthData(d){ try{ fs.writeFileSync(DATA_FILE,JSON.stringify(d)); }catch(e){} }

function parseHAEPayload(payload) {
  const metrics = payload?.data?.metrics || [];
  const result = {};
  metrics.forEach(metric => {
    const name = metric.name;
    const data = metric.data || [];
    switch(name) {
      case "weight_body_mass":
        const wEntry = data[data.length-1];
        if(wEntry) result.weight = wEntry.qty;
        break;
      case "body_fat_percentage":
        const bfEntry = data[data.length-1];
        if(bfEntry) result.bodyFat = bfEntry.qty;
        break;
      case "body_mass_index":
        const bmiEntry = data[data.length-1];
        if(bmiEntry) result.bmi = bmiEntry.qty;
        break;
      case "step_count":
        result.steps = data.reduce((sum,d)=>sum+(d.qty||0),0);
        break;
      case "active_energy":
        result.activeCalories = data.reduce((sum,d)=>sum+(d.qty||0),0);
        break;
      case "heart_rate_variability":
        if(data.length>0) result.hrv = data.reduce((sum,d)=>sum+(d.qty||0),0)/data.length;
        break;
      case "heart_rate":
        if(data.length>0) result.restingHR = data.reduce((sum,d)=>sum+(d.Avg||d.qty||0),0)/data.length;
        break;
      case "sleep_analysis":
        const s = data[0];
        if(s){ result.sleep=s.totalSleep||s.asleep||0; result.sleepDeep=s.deep||0; result.sleepREM=s.rem||0; result.sleepCore=s.core||0; result.sleepAwake=s.awake||0; }
        break;
      case "respiratory_rate":
        if(data.length>0) result.respiratoryRate = data.reduce((sum,d)=>sum+(d.qty||0),0)/data.length;
        break;
      case "walking_running_distance":
        result.distance = data.reduce((sum,d)=>sum+(d.qty||0),0);
        break;
      case "dietary_protein":
        result.protein = data.reduce((sum,d)=>sum+(d.qty||0),0); break;
      case "dietary_carbohydrates":
        result.carbs = data.reduce((sum,d)=>sum+(d.qty||0),0); break;
      case "dietary_fat_total":
        result.fat = data.reduce((sum,d)=>sum+(d.qty||0),0); break;
      case "dietary_energy":
        result.calories = data.reduce((sum,d)=>sum+(d.qty||0),0); break;
    }
  });
  return result;
}

app.post("/health", (req, res) => {
  const payload = req.body;
  const today = new Date().toISOString().split("T")[0];
  try{ fs.writeFileSync(DEBUG_FILE, JSON.stringify(payload,null,2)); }catch(e){}
  const update = parseHAEPayload(payload);
  update.date = today;
  update.lastSync = new Date().toISOString();
  const healthData = loadHealthData();
  healthData[today] = { ...(healthData[today]||{}), ...update };
  saveHealthData(healthData);
  res.json({ success:true, date:today, parsed:update });
});

app.post("/debug", (req, res) => {
  try{ fs.writeFileSync(DEBUG_FILE, JSON.stringify(req.body,null,2)); }catch(e){}
  const parsed = parseHAEPayload(req.body);
  res.json({ success:true, parsed });
});

app.get("/debug", (req, res) => {
  try{ res.json(JSON.parse(fs.readFileSync(DEBUG_FILE,"utf8"))); }
  catch(e){ res.json({ message:"No debug data yet" }); }
});

app.get("/health", (req, res) => {
  const healthData = loadHealthData();
  const today = new Date().toISOString().split("T")[0];
  const last7 = {};
  for(let i=0;i<7;i++){
    const d=new Date(); d.setDate(d.getDate()-i);
    const key=d.toISOString().split("T")[0];
    if(healthData[key]) last7[key]=healthData[key];
  }
  res.json({ today:healthData[today]||{}, history:last7 });
});

app.post("/health/manual", (req, res) => {
  const { password, data } = req.body;
  if(password!==ADMIN_PASSWORD) return res.status(401).json({ error:"Wrong password" });
  const today = new Date().toISOString().split("T")[0];
  const healthData = loadHealthData();
  healthData[today] = { ...(healthData[today]||{}), ...data, date:today };
  saveHealthData(healthData);
  res.json({ success:true });
});

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

    // Extract just the SCHED object - only modify schedule data, never touch HTML
    const schedMatch = content.match(/const SCHED=(\{[\s\S]*?\n\};)/);
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

    // Only replace the SCHED object, leave all HTML/CSS/JS untouched
    const updatedContent = content.replace(/const SCHED=\{[\s\S]*?\n\};/, `const SCHED=${newSched};`);

    if(updatedContent === content) {
      return res.status(500).json({ error:"Schedule update failed — please try again" });
    }

    await updateFile(updatedContent, sha, `Schedule update: ${instruction}`);
    res.json({ success:true, message:"Schedule updated! Refresh your app in 30 seconds." });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.get("/", (req, res) => res.send("Schedule API running"));
app.listen(process.env.PORT||3000, () => console.log("Server running"));
