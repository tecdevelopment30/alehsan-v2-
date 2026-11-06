# How alehsan-int.com is deployed

- **Website** (`index.html`): GitHub Pages, auto-deploys on every push to `main`.
- **Chat assistant** (`worker/chat-worker.js`): Cloudflare Worker `alehsan-assistant`
  on routes `alehsan-int.com/api/*` and `www.alehsan-int.com/api/*`. The rest of the
  site is untouched by the Worker.

## Assistant
- Gemini answers visitors (model `gemini-3.5-flash-lite`, falls back to `gemini-3.6-flash`, change with `GEMINI_MODEL`).
- When a visitor leaves name + email/phone + need, the lead is emailed through
  Cloudflare Email Service (`send_email` binding) to `LEAD_TO`, a verified
  Email Routing destination. Subject line shows the division. Free on Workers Free.
- Until `GEMINI_API_KEY` is set, `/api/chat` returns 503 and the page falls back
  to the old n8n webhook.

- Enquiries are saved in D1 database `alehsan-leads` (table `leads`) with a priority (high/medium/low).
- Daily report: cron `0 5 * * *` (08:00 Bahrain) emails a summary of the last 24 hours to `LEAD_TO` (only when there are new enquiries).
- Dashboard: https://alehsan-int.com/api/admin (needs the `ADMIN_TOKEN` secret).

## Required secrets
Cloudflare → Workers & Pages → `alehsan-assistant` → Settings → Variables and Secrets →
Add → Type **Secret** → `GEMINI_API_KEY`, and `ADMIN_TOKEN` (any long password) for the dashboard.

## Redeploying the Worker after code changes
```
cd worker
npx wrangler deploy
```
Set `LEAD_TO` in the dashboard (kept out of this public repo).

## Lead routing
Edit `DIVISIONS` at the top of `worker/chat-worker.js`.
