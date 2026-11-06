# Deploying alehsan-int.com on Cloudflare Pages (free)

The site is static (`index.html`) plus one serverless function, `functions/api/chat.js`,
which runs the Gemini assistant and emails leads through Brevo. GitHub Pages can't run
the function, so the site is hosted on Cloudflare Pages instead (free, commercial use allowed,
and the domain's DNS is already on Cloudflare).

## 1. Create the Pages project
Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick this repo.
- Production branch: `main`
- Framework preset: None · Build command: (empty) · Output directory: `/`

## 2. Add variables (Settings → Variables and Secrets, Production)
| Name | Type | Value |
|---|---|---|
| `GEMINI_API_KEY` | Secret | Google AI Studio key |
| `BREVO_API_KEY` | Secret | Brevo → SMTP & API → API keys |
| `LEAD_CC` | Text (optional) | e.g. `info@alehsan-int.com` |
| `GEMINI_MODEL` | Text (optional) | default `gemini-3.8-flash` |
| `BREVO_SENDER` | Text (optional) | default `assistant@alehsan-int.com` |

Redeploy after adding variables.

## 3. Test on the `*.pages.dev` URL
Open the chat, give a name + email + need, and confirm the division lead receives the email.

## 4. Move the domain
Pages project → Custom domains → add `alehsan-int.com` (and `www`). Cloudflare replaces the
GitHub Pages DNS records. MX / SPF / DKIM / DMARC records are not touched, so email keeps working.
Then turn off GitHub Pages in the repo settings.

## Lead routing
Edit `DIVISIONS` at the top of `functions/api/chat.js` to change who receives each type of enquiry.
