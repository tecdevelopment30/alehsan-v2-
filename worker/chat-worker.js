// ALehsan Assistant — Cloudflare Worker on route alehsan-int.com/api/*
// The site itself stays on GitHub Pages; this Worker only answers /api/chat.
// Gemini answers visitors; when a visitor leaves contact details, the lead is
// emailed through Cloudflare Email Service (send_email binding) to a verified
// Email Routing destination. Free: no n8n, no Brevo, no subscription.
//
// Bindings / variables (Workers → alehsan-assistant → Settings):
//   GEMINI_API_KEY   (secret, required)  Google AI Studio key
//   EMAIL            (send_email binding)
//   LEAD_TO          (text) verified Email Routing destination that receives leads
//   LEAD_FROM        (text, optional) default: assistant@alehsan-int.com
//   GEMINI_MODEL     (text, optional) default: gemini-3.5-flash-lite
//   DB               (D1 binding) database alehsan-leads, table leads
//   ADMIN_TOKEN      (secret) password for the /api/admin dashboard
// Cron trigger: daily report of the last 24h of enquiries to LEAD_TO.

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-3.6-flash';
const MAX_TURNS = 20;          // history messages kept per request
const MAX_CHARS = 2000;        // per message

const DIVISIONS = {
  project_management: { label: 'Project Management', to: ['raji@alehsan-int.com', 'raji.sarar@alehsan-int.com'] },
  ai_automation:      { label: 'AI & Automation Systems', to: ['ismail@alehsan-int.com'] },
  real_estate:        { label: 'Real Estate', to: ['bushra@alehsan-int.com', 'zeyad@alehsan-int.com'] },
  construction:       { label: 'Construction, MEP & Engineering', to: ['qusai@alehsan-int.com'] },
  oil_gas_trading:    { label: 'Oil & Gas / Trading', to: ['qusai@alehsan-int.com'] },
  interior_design:    { label: 'Interior Design', to: ['saeb@alehsan-int.com'] },
  data_digital:       { label: 'Data Analysis & Digital Solutions', to: ['mouad@alehsan-int.com'] },
  general:            { label: 'General enquiry', to: ['info@alehsan-int.com'] },
};

const SYSTEM_PROMPT = `You are "ALehsan Assistant", the website assistant of Alehsan International Development Co. (AID), alehsan-int.com.

LANGUAGE: Always reply in the visitor's language (Arabic or English, or other). Keep replies short (2–5 sentences), warm and professional. Plain text only, no markdown.

COMPANY FACTS (only use these; never invent numbers, prices, clients or timelines):
- AID: mid-sized, financially strong, 100% GCC-owned equity. Business history from Abu Dhabi, UAE, 1968. Registered in the Kingdom of Bahrain since 2006. AIC (Alehsan International Contracting), the general contracting arm, founded 2010. Al Majdal Contracting & Trading (UAE, founded 1990) designs multi-storey buildings.
- Head office: Building 2752, Road 2442, Block 324, Juffair, Manama, Bahrain. Tel +971 5665946. Email info@alehsan-int.com.
- Services: Civil construction (industrial, commercial, residential, marina maintenance); MEP (cable laying, switchgear, control panels, control rooms, fire alarms; piping CS/SS/GRP/P91/P22/HDPE, motors and pumps, steel structures and warehouses, gantry and tower cranes, fire-fighting networks); Project management, design & value engineering (tendering, procurement, planning, concept and detailed design, legal consultation); Oil & gas technical services with partners AGI (France), training/inspection/NDT with AAK (Norway), drilling-site environmental solutions with Soiltech (Norway), maintenance products with RS Clare (UK: flooring systems, wellhead and valve lubricants, thermoplastic road marking); Commercial & trading (import/export of cement, building materials, electrical goods, machinery, heavy and marine equipment); AI & automation (process automation and control integration, predictive maintenance, analytics dashboards, smart buildings); Real estate development & investment (residential/commercial/mixed-use, land acquisition, feasibility, investment structuring, facilities management); Robotics & mechatronics (robotic inspection and maintenance, mechatronic design, automation retrofits, training and after-sales); Interior design (concept, space planning, materials and finishes, lighting, furniture and joinery, fit-out for residential, commercial and hospitality); Data analysis & digital solutions (business intelligence, dashboards and reporting, data pipelines, web platforms and apps, digital transformation).
- Selected projects: Bahrain National Assembly (artificial island and infrastructure, USD 100M); Khafji KSA sewage treatment plant and marine outfall (USD 40M, client Al Kawther); Dubai Al Maktoum International (DWC) VVIP building (USD 30M); Bahrain Financial Harbour (design & build under Al Hamd Development); Tilal Towers Amwaj (2010, Al Matrook Development); Marina West Development; Marriott Hotel Manama; Al Dur Power Station; Hidd Power Station road works; villas in East Riffa and Sanad.
- Quality per API and ISO standards with a Quality Assurance Manager; safety officer on each site; EIA, EMP, environmental monitoring and waste management plans. Equipment fleet of 81 owned and rented units. Values: Time, and Trust & Loyalty.
- Division leads: Project Management — Mr Raji; AI & Automation — Mr Ismail; Real Estate — Mrs Bushra; Construction & Engineering — Mr Qusai; Interior Design — Mr Saeb; Data Analysis & Digital Solutions — Mr Mouad.

WHAT YOU CAN DO (tell visitors when relevant, especially in your first reply):
- Explain AID's services, projects and partners.
- Ask a few questions to understand their project, then prepare a written enquiry report (summary, key details, priority) and send it straight to the right division lead, who will follow up.
You cannot send emails to the visitor, give prices or quotes, or book meetings yourself; the lead will do that.

HOW TO HANDLE A CONVERSATION:
1. Greet briefly, say what you can do, and ask which service they are interested in. If they pick a service, explain it in 2–3 sentences with one or two relevant AID projects, then start qualifying.
2. Qualifying questions (ask 2 at a time, max 4–5 in total, skip what they already said):
   - Construction / MEP / engineering: project type, location, size or scope, current stage (idea, design, tender, construction), timeline.
   - Project management: project type and size, stage, what support they need (planning, tendering, supervision, value engineering).
   - Oil & gas / trading: product or service needed, quantities, location, timeline.
   - Real estate: buy, develop or invest; location; property type; budget range.
   - Interior design: space type (villa, apartment, office, hotel, retail), area in m², location, style or references, budget range, timeline.
   - AI & automation / robotics: the process or equipment to improve, current systems, goal.
   - Data analysis & digital solutions: business type, data sources (Excel, ERP, CRM...), what decisions or reports they need, any website or app needed.
3. Then ask for their name and an email or phone number.
4. Call submit_lead exactly once with everything you learned: summary in one sentence, details as short "Key: value" lines, and priority:
   high = clear project with budget or timeline in the next 3 months; medium = defined need, still exploring; low = general question or very early idea.
5. After it succeeds, tell the visitor their enquiry report was sent to the named lead, who will contact them soon. Never claim it was sent unless submit_lead returned ok:true.
6. Never ask for passwords, ID numbers or payment details. Politely decline off-topic requests (homework, coding, etc.) and steer back to AID.`;

const TOOLS = [{
  functionDeclarations: [{
    name: 'submit_lead',
    description: "Send the visitor's enquiry to the right ALehsan division lead by email. Call only once you have name, a contact (email or phone) and a summary of the need.",
    parameters: {
      type: 'object',
      properties: {
        name:     { type: 'string', description: "Visitor's full name" },
        email:    { type: 'string', description: "Visitor's email, if given" },
        phone:    { type: 'string', description: "Visitor's phone, if given" },
        company:  { type: 'string', description: "Visitor's company, if given" },
        division: { type: 'string', enum: Object.keys(DIVISIONS) },
        summary:  { type: 'string', description: 'One-sentence summary of the need, in English' },
        details:  { type: 'string', description: 'Answers to the qualifying questions as short "Key: value" lines, in English' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        language: { type: 'string', description: 'Language the visitor used' },
      },
      required: ['name', 'division', 'summary'],
    },
  }],
}];

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const ok = /^https:\/\/(www\.)?alehsan-int\.com$/.test(origin) || /\.pages\.dev$/.test(origin) || origin.startsWith('http://localhost');
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
}

async function onOptions(request) {
  return new Response(null, { headers: { ...corsHeaders(request), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}

async function onPost(request, env) {
  const cors = corsHeaders(request);
  if (!env.GEMINI_API_KEY) return json({ reply: 'The assistant is not configured yet. Please email info@alehsan-int.com.' }, 503, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400, cors); }

  // history: [{role:'user'|'bot', text}]
  const history = Array.isArray(body.history) ? body.history : [];
  const contents = history.slice(-MAX_TURNS)
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .map(m => ({ role: m.role === 'bot' ? 'model' : 'user', parts: [{ text: m.text.slice(0, MAX_CHARS) }] }));
  while (contents.length && contents[0].role !== 'user') contents.shift();
  if (!contents.length || contents[contents.length - 1].role !== 'user') return json({ error: 'no user message' }, 400, cors);

  const leadAlreadySent = body.leadSent === true;
  let leadSent = false;

  try {
    for (let step = 0; step < 3; step++) {
      const data = await callGeminiWithFallback(env, contents);
      const content = data?.candidates?.[0]?.content;
      const parts = content?.parts || [];
      const call = parts.find(p => p.functionCall)?.functionCall;

      if (!call) {
        const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
        return json({ reply: text || "Sorry, could you rephrase that?", leadSent }, 200, cors);
      }

      // keep the model turn verbatim (includes thought signatures)
      contents.push(content);
      let result;
      if (call.name === 'submit_lead' && !leadAlreadySent && !leadSent) {
        result = await sendLead(env, call.args || {}, history);
        leadSent = result.ok === true;
      } else {
        result = { ok: false, error: leadAlreadySent || leadSent ? 'Lead already submitted in this chat.' : 'Unknown tool' };
      }
      contents.push({ role: 'user', parts: [{ functionResponse: { name: call.name, response: result } }] });
    }
    return json({ reply: 'Thank you — our team will be in touch shortly.', leadSent }, 200, cors);
  } catch (err) {
    console.log('CHAT_ERR ' + String(err && err.message || err).replace(/\s+/g, ' '));
    return json({ reply: "I'm having trouble right now. Please email info@alehsan-int.com", leadSent }, 502, cors);
  }
}

async function callGeminiWithFallback(env, contents) {
  const primary = env.GEMINI_MODEL || DEFAULT_MODEL;
  try { return await callGemini(env, contents, primary); }
  catch (e) { console.log('GEMINI_FAIL ' + primary + ' ' + String(e.message || e).replace(/\s+/g, ' ')); }
  return callGemini(env, contents, FALLBACK_MODEL);
}

async function callGemini(env, contents, model) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: TOOLS,
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 400).replace(/\s+/g, ' ')}`);
  return res.json();
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PRI = { high: 'High', medium: 'Medium', low: 'Low' };

async function sendLead(env, a, history) {
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email || '') ? a.email.trim() : '';
  const phone = String(a.phone || '').replace(/[^\d+\s()-]/g, '').trim();
  if (!a.name || (!email && !phone)) return { ok: false, error: 'Need name and an email or phone first' };

  const divKey = DIVISIONS[a.division] ? a.division : 'general';
  const div = DIVISIONS[divKey];
  const priority = PRI[a.priority] ? a.priority : 'medium';
  const transcriptText = history.slice(-MAX_TURNS).map(m => `${m.role === 'bot' ? 'Assistant' : 'Visitor'}: ${String(m.text).slice(0, MAX_CHARS)}`).join('\n');

  let saved = false, id = null;
  if (env.DB) {
    try {
      const r = await env.DB.prepare(`INSERT INTO leads (name, email, phone, company, division, summary, details, language, priority, transcript)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`)
        .bind(String(a.name).slice(0, 120), email, phone, String(a.company || '').slice(0, 120), divKey,
              String(a.summary || '').slice(0, 500), String(a.details || '').slice(0, 2000), String(a.language || '').slice(0, 40), priority, transcriptText.slice(0, 20000))
        .first();
      saved = true; id = r && r.id;
    } catch (e) { console.log('DB_ERR ' + String(e.message || e)); }
  }

  let emailed = false;
  if (env.EMAIL && env.LEAD_TO) {
    const rows = [['Ref', id ? '#' + id : '—'], ['Priority', PRI[priority]], ['Division', div.label], ['For', div.to.join(', ')], ['Name', a.name], ['Email', email || '—'], ['Phone', phone || '—'],
      ['Company', a.company || '—'], ['Language', a.language || '—'], ['Need', a.summary || '—']];
    const details = String(a.details || '').split('\n').filter(Boolean);
    const color = { high: '#b3261e', medium: '#8a6a33', low: '#5a6270' }[priority];
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
<h2 style="margin:0 0 4px">Enquiry report — ${esc(div.label)}</h2>
<p style="margin:0 0 16px"><span style="background:${color};color:#fff;padding:3px 10px;border-radius:10px;font-size:12px">${PRI[priority]} priority</span></p>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="color:#666"><b>${k}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>
${details.length ? `<h3>Project details</h3><ul style="font-size:14px">${details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
<h3>Conversation</h3><div style="font-size:13px;color:#333;white-space:pre-wrap">${esc(transcriptText)}</div>
<p style="color:#888;font-size:12px">Sent automatically by the ALehsan Assistant on alehsan-int.com</p></div>`;
    const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (details.length ? '\n\nDetails:\n' + details.join('\n') : '') + '\n\n' + transcriptText;
    try {
      await env.EMAIL.send({
        from: { email: env.LEAD_FROM || 'assistant@alehsan-int.com', name: 'ALehsan Assistant' },
        to: env.LEAD_TO,
        ...(email && { replyTo: email }),
        subject: `[${div.label}] ${PRI[priority]} — New enquiry from ${String(a.name).slice(0, 80)}${id ? ' (#' + id + ')' : ''}`,
        html, text,
      });
      emailed = true;
      if (saved && id) await env.DB.prepare('UPDATE leads SET emailed = 1 WHERE id = ?1').bind(id).run();
    } catch (e) { console.log('EMAIL_ERR ' + String(e.message || e)); }
  }
  if (!saved && !emailed) return { ok: false, error: 'Enquiry could not be delivered' };
  return { ok: true, routed_to: div.label, reference: id };
}

/* ---------- Daily report (cron) ---------- */
async function dailyReport(env) {
  if (!env.DB || !env.EMAIL || !env.LEAD_TO) return;
  const { results } = await env.DB.prepare(`SELECT id, created_at, name, email, phone, division, summary, priority, status FROM leads
    WHERE created_at >= datetime('now', '-1 day') ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id DESC`).all();
  const open = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status = 'new'`).first();
  if (!results.length) return;
  const byDiv = {}; const byPri = { high: 0, medium: 0, low: 0 };
  for (const r of results) { byDiv[r.division] = (byDiv[r.division] || 0) + 1; byPri[r.priority] = (byPri[r.priority] || 0) + 1; }
  const divRows = Object.entries(byDiv).map(([k, n]) => `<tr><td>${esc((DIVISIONS[k] || DIVISIONS.general).label)}</td><td align="right"><b>${n}</b></td></tr>`).join('');
  const list = results.map(r => `<tr><td>#${r.id}</td><td>${esc(PRI[r.priority] || r.priority)}</td><td>${esc((DIVISIONS[r.division] || DIVISIONS.general).label)}</td><td>${esc(r.name)}<br><span style="color:#666">${esc(r.email || r.phone)}</span></td><td>${esc(r.summary)}</td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:720px">
<h2>Daily enquiries report — ALehsan</h2>
<p><b>${results.length}</b> new enquiries in the last 24 hours · High ${byPri.high} · Medium ${byPri.medium} · Low ${byPri.low} · <b>${open ? open.n : 0}</b> still marked new</p>
<h3>By division</h3><table cellpadding="6" style="border-collapse:collapse;font-size:14px">${divRows}</table>
<h3>Enquiries</h3><table cellpadding="6" border="1" style="border-collapse:collapse;font-size:13px;border-color:#ddd"><tr><th>Ref</th><th>Priority</th><th>Division</th><th>Contact</th><th>Need</th></tr>${list}</table>
<p style="color:#888;font-size:12px">Manage enquiries at https://alehsan-int.com/api/admin</p></div>`;
  await env.EMAIL.send({
    from: { email: env.LEAD_FROM || 'assistant@alehsan-int.com', name: 'ALehsan Assistant' },
    to: env.LEAD_TO,
    subject: `Daily report: ${results.length} new enquiries (${byPri.high} high priority)`,
    html, text: `${results.length} new enquiries in the last 24 hours. Open https://alehsan-int.com/api/admin to manage them.`,
  });
}

/* ---------- Admin dashboard ---------- */
function authed(request, env) {
  const h = request.headers.get('Authorization') || '';
  return !!env.ADMIN_TOKEN && h === 'Bearer ' + env.ADMIN_TOKEN;
}

async function adminApi(request, env, url) {
  if (!env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN secret is not set on the Worker' }, 503);
  if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
  if (!env.DB) return json({ error: 'no database' }, 503);
  const m = url.pathname.match(/^\/api\/admin\/leads\/(\d+)$/);
  if (m && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (!['new', 'contacted', 'closed'].includes(body.status)) return json({ error: 'bad status' }, 400);
    await env.DB.prepare('UPDATE leads SET status = ?1 WHERE id = ?2').bind(body.status, Number(m[1])).run();
    return json({ ok: true });
  }
  if (url.pathname === '/api/admin/leads' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, created_at, name, email, phone, company, division, summary, details, language, priority, status, emailed FROM leads ORDER BY id DESC LIMIT 500').all();
    return json({ leads: results.map(r => ({ ...r, division_label: (DIVISIONS[r.division] || DIVISIONS.general).label })) });
  }
  return json({ error: 'not found' }, 404);
}

const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>ALehsan Enquiries</title><style>
:root{--ink:#0c1119;--sand:#f4f0e8;--line:rgba(24,32,44,.12);--brass:#8a6a33;--muted:#5a6270}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial,sans-serif;background:var(--sand);color:#18202c}
header{background:var(--ink);color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
header b{font-family:Georgia,serif;font-size:20px}header b span{color:#dcc07f}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px}.stat .k{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--brass)}.stat .v{font-size:26px;font-weight:600;margin-top:4px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}select,input,button{font:inherit;padding:8px 12px;border-radius:10px;border:1px solid var(--line);background:#fff}
button{cursor:pointer}button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:10px;display:grid;grid-template-columns:1fr auto;gap:8px 16px}
.meta{font-size:12px;color:var(--muted)}.name{font-weight:600;font-size:16px}.need{margin:6px 0}.details{white-space:pre-wrap;font-size:13px;color:var(--muted);margin-top:6px}
.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;color:#fff;margin-right:6px}.high{background:#b3261e}.medium{background:#8a6a33}.low{background:#5a6270}
.side{display:flex;flex-direction:column;gap:6px;align-items:flex-end}a{color:var(--brass)}
#login{max-width:360px;margin:80px auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:24px}#login input{width:100%;margin:12px 0}
@media(max-width:640px){.card{grid-template-columns:1fr}.side{align-items:flex-start;flex-direction:row;flex-wrap:wrap}}
</style></head><body>
<header><b>AL<span>ehsan</span> · Enquiries</b><button id="logout" style="display:none">Sign out</button></header>
<div id="login"><b>Admin access</b><p class="meta">Enter the ADMIN_TOKEN set on the Worker.</p><input id="tok" type="password" autocomplete="current-password"><button class="primary" id="go">Open dashboard</button><p id="err" class="meta" style="color:#b3261e"></p></div>
<main id="app" style="display:none"><div class="stats" id="stats"></div>
<div class="bar"><select id="fdiv"><option value="">All divisions</option></select><select id="fstat"><option value="">All statuses</option><option>new</option><option>contacted</option><option>closed</option></select><select id="fpri"><option value="">All priorities</option><option>high</option><option>medium</option><option>low</option></select><input id="q" placeholder="Search name, email, need"></div>
<div id="list"></div></main>
<script>
let T='';try{T=sessionStorage.getItem('alt')||''}catch(e){}
let LEADS=[];const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){const r=await fetch('/api/admin/leads',{headers:{Authorization:'Bearer '+T}});
 if(!r.ok){$('err').textContent=r.status===401?'Wrong token':'Error '+r.status+': '+((await r.json().catch(()=>({}))).error||'');showLogin();return}
 LEADS=(await r.json()).leads;$('login').style.display='none';$('app').style.display='block';$('logout').style.display='inline-block';
 const divs=[...new Set(LEADS.map(l=>l.division_label))];$('fdiv').innerHTML='<option value="">All divisions</option>'+divs.map(d=>'<option>'+esc(d)+'</option>').join('');render()}
function showLogin(){$('login').style.display='block';$('app').style.display='none';$('logout').style.display='none'}
function render(){const fd=$('fdiv').value,fs=$('fstat').value,fp=$('fpri').value,q=$('q').value.toLowerCase();
 const L=LEADS.filter(l=>(!fd||l.division_label===fd)&&(!fs||l.status===fs)&&(!fp||l.priority===fp)&&(!q||(l.name+' '+l.email+' '+l.phone+' '+l.summary+' '+l.details).toLowerCase().includes(q)));
 const day=LEADS.filter(l=>Date.now()-Date.parse(l.created_at.replace(' ','T')+'Z')<864e5).length;
 $('stats').innerHTML=[['Total',LEADS.length],['Last 24h',day],['New',LEADS.filter(l=>l.status==='new').length],['High priority',LEADS.filter(l=>l.priority==='high').length]].map(([k,v])=>'<div class="stat"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');
 $('list').innerHTML=L.length?L.map(l=>'<div class="card"><div><div class="meta">#'+l.id+' · '+esc(l.created_at)+' UTC · '+esc(l.division_label)+(l.language?' · '+esc(l.language):'')+'</div><div class="name"><span class="pill '+esc(l.priority)+'">'+esc(l.priority)+'</span>'+esc(l.name)+(l.company?' · '+esc(l.company):'')+'</div><div class="need">'+esc(l.summary)+'</div>'+(l.details?'<div class="details">'+esc(l.details)+'</div>':'')+'</div><div class="side">'+(l.email?'<a href="mailto:'+esc(l.email)+'">'+esc(l.email)+'</a>':'')+(l.phone?'<a href="tel:'+esc(l.phone)+'">'+esc(l.phone)+'</a>':'')+'<select data-id="'+l.id+'">'+['new','contacted','closed'].map(s=>'<option'+(s===l.status?' selected':'')+'>'+s+'</option>').join('')+'</select></div></div>').join(''):'<p class="meta">No enquiries match.</p>'}
$('list').addEventListener('change',async e=>{const s=e.target.closest('select[data-id]');if(!s)return;const id=+s.dataset.id;
 const r=await fetch('/api/admin/leads/'+id,{method:'POST',headers:{Authorization:'Bearer '+T,'Content-Type':'application/json'},body:JSON.stringify({status:s.value})});
 if(r.ok){LEADS.find(l=>l.id===id).status=s.value;render()}else alert('Could not update')});
['fdiv','fstat','fpri','q'].forEach(id=>$(id).addEventListener('input',render));
$('go').onclick=()=>{T=$('tok').value.trim();try{sessionStorage.setItem('alt',T)}catch(e){}load()};
$('tok').addEventListener('keydown',e=>{if(e.key==='Enter')$('go').click()});
$('logout').onclick=()=>{T='';try{sessionStorage.removeItem('alt')}catch(e){}showLogin()};
if(T)load();
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/admin') return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url);
    if (url.pathname !== '/api/chat') return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return onOptions(request);
    if (request.method === 'POST') return onPost(request, env);
    return new Response('Method not allowed', { status: 405 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyReport(env).catch(e => console.log('REPORT_ERR ' + String(e.message || e))));
  },
};
