# DeXpress Backend (generated)

This folder contains a ready-to-run Express backend that integrates with Supabase.

## What's included
- `server.js` — main Express server (endpoints for projects, deploys, runs, logs, optional chat)
- `supabaseClient.js` — small helper to initialize Supabase client
- `scripts/create_tables.sql` — SQL to create the required tables in Supabase
- `.env.example` — environment variables example
- `package.json` — project metadata and dependencies

## Setup

1. Copy `.env.example` to `.env` and fill in values. Example:
```
SUPABASE_URL=https://vhabmnuuctkgghgympbc.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoYWJtbnV1Y3RrZ2doZ3ltcGJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQzNDg4MDUsImV4cCI6MjA3OTkyNDgwNX0.2eAHv1uCklQ9DNpTh1-175oFSCHTkVKK1ikxPACTWZw
OPENAI_API_KEY=          # optional, for chatbot proxy
PORT=8787
```

> Note: For server-side operations, using the `service_role` key is recommended. Keep the key secret — do NOT expose it in frontend code.

2. Install dependencies:
```bash
cd backend
npm install
```

3. Create the database tables in Supabase:
- Open Supabase dashboard → SQL Editor → paste `scripts/create_tables.sql` → Run.

4. Start the server:
```bash
npm start
```
The server will run at http://localhost:8787 by default.

## How to connect the frontend

### 1) Supabase client for frontend (auth)
In your frontend pages (login.html and main.html) add the Supabase client script in the `<head>`:
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
  const SUPABASE_URL = 'https://vhabmnuuctkgghgympbc.supabase.co';
  const SUPABASE_ANON_KEY = '<YOUR_SUPABASE_ANON_KEY>'; // obtain from Supabase Project -> API -> anon key
  window.supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
</script>
```

After login you'll have a session token; to call server endpoints that require authentication, include the token as:
```js
const { data: { session } } = await supabase.auth.getSession();
const jwt = session?.access_token;
fetch('http://localhost:8787/api/projects', {
  headers: { Authorization: 'Bearer ' + jwt }
});
```

### 2) Call deploy endpoint
Modify your frontend `startDeployment(payload)` to post to backend:
```js
const jwt = (await supabase.auth.getSession()).data?.session?.access_token;
const res = await fetch('http://localhost:8787/api/deploy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
  body: JSON.stringify({ payload })
});
const json = await res.json();
```

### 3) Realtime / polling
The backend writes logs and run records into Supabase tables. You can poll `/api/runs/:id` or subscribe using Supabase Realtime to `run_logs` table to stream logs to the frontend.

## Chatbot integration (the "?" button)
- The backend includes `/api/chat` which proxies to OpenAI if `OPENAI_API_KEY` is set.
- Frontend can open a small modal when the `?` button is clicked and POST messages to `/api/chat`.
- Example frontend call:
```js
const res = await fetch('http://localhost:8787/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
});
const data = await res.json();
```
If you want, I can also produce a ready-to-drop-in chat UI (modal) and patch your `main.html` to open it from the `?` floating button.

## Notes
- Keep the SUPABASE_KEY secret. Do not embed it into client-side code.
- If you plan to deploy the backend, set the environment variables on the host (Render, Vercel, etc.)
- The simulator uses background `setTimeout` to mimic a build. Replace `simulateBuild` with a real worker or CI integration for production.
