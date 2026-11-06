// ALehsan Assistant — Cloudflare Pages Function (POST /api/chat)
// Gemini answers visitors; when a visitor leaves contact details, the lead is
// emailed to the right division head through Brevo. No n8n, no subscriptions.
//
// Environment variables (Cloudflare Pages → Settings → Variables and Secrets):
//   GEMINI_API_KEY   (secret, required)  Google AI Studio key
//   BREVO_API_KEY    (secret, required for lead emails)
//   GEMINI_MODEL     (optional)  default: gemini-3.8-flash
//   BREVO_SENDER     (optional)  default: assistant@alehsan-int.com
//   LEAD_CC          (optional)  e.g. info@alehsan-int.com — copied on every lead

const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_TURNS = 20;          // history messages kept per request
const MAX_CHARS = 2000;        // per message

const DIVISIONS = {
  project_management: { label: 'Project Management', to: ['raji@alehsan-int.com', 'raji.sarar@alehsan-int.com'] },
  ai_automation:      { label: 'AI & Automation Systems', to: ['ismail@alehsan-int.com'] },
  real_estate:        { label: 'Real Estate', to: ['bushra@alehsan-int.com', 'zeyad@alehsan-int.com'] },
  construction:       { label: 'Construction, MEP & Engineering', to: ['qusai@alehsan-int.com'] },
  oil_gas_trading:    { label: 'Oil & Gas / Trading', to: ['qusai@alehsan-int.com'] },
  general:            { label: 'General enquiry', to: ['info@alehsan-int.com'] },
};

const SYSTEM_PROMPT = `You are "ALehsan Assistant", the website assistant of Alehsan International Development Co. (AID), alehsan-int.com.

LANGUAGE: Always reply in the visitor's language (Arabic or English, or other). Keep replies short (2–5 sentences), warm and professional. Plain text only, no markdown.

COMPANY FACTS (only use these; never invent numbers, prices, clients or timelines):
- AID: mid-sized, financially strong, 100% GCC-owned equity. Business history from Abu Dhabi, UAE, 1968. Registered in the Kingdom of Bahrain since 2006. AIC (Alehsan International Contracting), the general contracting arm, founded 2010. Al Majdal Contracting & Trading (UAE, founded 1990) designs multi-storey buildings.
- Head office: Building 2752, Road 2442, Block 324, Juffair, Manama, Bahrain. Tel +973 363 66661 / +971 5665946. Email info@alehsan-int.com.
- Services: Civil construction (industrial, commercial, residential, marina maintenance); MEP (cable laying, switchgear, control panels, control rooms, fire alarms; piping CS/SS/GRP/P91/P22/HDPE, motors and pumps, steel structures and warehouses, gantry and tower cranes, fire-fighting networks); Project management, design & value engineering (tendering, procurement, planning, concept and detailed design, legal consultation); Oil & gas technical services with partners AGI (France), training/inspection/NDT with AAK (Norway), drilling-site environmental solutions with Soiltech (Norway), maintenance products with RS Clare (UK: flooring systems, wellhead and valve lubricants, thermoplastic road marking); Commercial & trading (import/export of cement, building materials, electrical goods, machinery, heavy and marine equipment); AI & automation (process automation and control integration, predictive maintenance, analytics dashboards, smart buildings); Real estate development & investment (residential/commercial/mixed-use, land acquisition, feasibility, investment structuring, facilities management); Robotics & mechatronics (robotic inspection and maintenance, mechatronic design, automation retrofits, training and after-sales).
- Selected projects: Bahrain National Assembly (artificial island and infrastructure, USD 100M); Khafji KSA sewage treatment plant and marine outfall (USD 40M, client Al Kawther); Dubai Al Maktoum International (DWC) VVIP building (USD 30M); Bahrain Financial Harbour (design & build under Al Hamd Development); Tilal Towers Amwaj (2010, Al Matrook Development); Marina West Development; Marriott Hotel Manama; Al Dur Power Station; Hidd Power Station road works; villas in East Riffa and Sanad.
- Quality per API and ISO standards with a Quality Assurance Manager; safety officer on each site; EIA, EMP, environmental monitoring and waste management plans. Equipment fleet of 81 owned and rented units. Values: Time, and Trust & Loyalty.
- Division leads: Project Management — Mr Raji; AI & Automation — Mr Ismail; Real Estate — Mrs Bushra; Construction & Engineering — Mr Qusai.

YOUR JOB:
1. Understand what the visitor needs and answer questions using the facts above. If you don't know something, say the team will confirm it.
2. Route them: pick the best division and offer to have that lead follow up.
3. To hand over, you need: the visitor's name, AND an email or phone number, AND a short description of the need. Ask for missing items naturally, one or two at a time.
4. Once you have them, call submit_lead exactly once. After it succeeds, tell the visitor which lead will contact them. Never claim a message was sent unless submit_lead returned ok:true.
5. Never ask for passwords, ID numbers or payment details. Politely decline off-topic requests (homework, coding, etc.) and steer back to AID.`;

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
        summary:  { type: 'string', description: 'Short summary of the need, in English' },
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

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: { ...corsHeaders(request), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}

export async function onRequestPost({ request, env }) {
  const cors = corsHeaders(request);
  if (!env.GEMINI_API_KEY) return json({ reply: 'The assistant is not configured yet. Please email info@alehsan-int.com.' }, 500, cors);

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
      const data = await callGemini(env, contents);
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
    console.error(err);
    return json({ reply: "I'm having trouble right now. Please email info@alehsan-int.com or call +973 363 66661.", leadSent }, 502, cors);
  }
}

async function callGemini(env, contents) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: TOOLS,
      generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendLead(env, a, history) {
  if (!env.BREVO_API_KEY) return { ok: false, error: 'Email service not configured' };
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email || '') ? a.email.trim() : '';
  const phone = String(a.phone || '').replace(/[^\d+\s()-]/g, '').trim();
  if (!a.name || (!email && !phone)) return { ok: false, error: 'Need name and an email or phone first' };

  const div = DIVISIONS[a.division] || DIVISIONS.general;
  const to = div.to.map(e => ({ email: e }));
  const cc = env.LEAD_CC ? [{ email: env.LEAD_CC }] : undefined;
  const transcript = history.slice(-MAX_TURNS)
    .map(m => `<p><b>${m.role === 'bot' ? 'Assistant' : 'Visitor'}:</b> ${esc(m.text).slice(0, MAX_CHARS)}</p>`).join('');

  const html = `<h2>New website enquiry — ${esc(div.label)}</h2>
<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
<tr><td><b>Name</b></td><td>${esc(a.name)}</td></tr>
<tr><td><b>Email</b></td><td>${esc(email || '—')}</td></tr>
<tr><td><b>Phone</b></td><td>${esc(phone || '—')}</td></tr>
<tr><td><b>Company</b></td><td>${esc(a.company || '—')}</td></tr>
<tr><td><b>Language</b></td><td>${esc(a.language || '—')}</td></tr>
<tr><td><b>Need</b></td><td>${esc(a.summary)}</td></tr></table>
<h3>Conversation</h3><div style="font-family:Arial,sans-serif;font-size:13px;color:#333">${transcript}</div>
<p style="color:#888;font-size:12px">Sent automatically by the ALehsan Assistant on alehsan-int.com</p>`;

  const payload = {
    sender: { name: 'ALehsan Assistant', email: env.BREVO_SENDER || 'assistant@alehsan-int.com' },
    to, ...(cc && { cc }),
    ...(email && { replyTo: { email, name: String(a.name).slice(0, 80) } }),
    subject: `New enquiry (${div.label}) — ${String(a.name).slice(0, 80)}`,
    htmlContent: html,
  };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'accept': 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { console.error('Brevo', res.status, await res.text()); return { ok: false, error: 'Email could not be sent' }; }
  return { ok: true, routed_to: div.label };
}
