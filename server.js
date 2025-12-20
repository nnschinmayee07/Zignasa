// server.js
// Express backend that integrates with Supabase (service or anon key provided via env).
// Provides endpoints: /api/projects, /api/deploy, /api/runs/:id, /api/logs/:runId, /api/chat (optional)
//
// Usage:
//  - copy .env.example -> .env and fill values (SUPABASE_URL and SUPABASE_KEY required).
//  - npm install
//  - npm start

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const PORT = process.env.PORT || 8787;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role OR anon key (recommended: service_role for server)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

if(!SUPABASE_URL || !SUPABASE_KEY){
  console.error("Missing SUPABASE_URL or SUPABASE_KEY in environment. See .env.example");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// verify user middleware: optional. If an Authorization: Bearer <token> header is present,
// attempts to decode it using Supabase and attach req.user = { id, email, ... }
async function verifyUser(req, res, next){
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  if(!token){
    req.user = null;
    return next();
  }
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if(error || !data?.user){
      req.user = null;
    } else {
      req.user = data.user;
    }
  } catch(err){
    console.warn('verifyUser error', err);
    req.user = null;
  }
  return next();
}

// Utility helpers
function nowISO(){ return new Date().toISOString(); }

app.get('/health', (req, res) => res.json({ ok: true, now: nowISO() }));

// Get projects for current authenticated user
app.get('/api/projects', verifyUser, async (req, res) => {
  try {
    if(!req.user) return res.status(401).json({ error: 'not_authenticated' });
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('owner', req.user.id)
      .order('created_at', { ascending: false });

    if(error) return res.status(500).json({ error: error.message });
    res.json({ projects: data || [] });
  } catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get runs (optionally filtered by project_id)
app.get('/api/runs', verifyUser, async (req, res) => {
  try {
    if(!req.user) return res.status(401).json({ error: 'not_authenticated' });
    const projectId = req.query.project_id;
    let query = supabase.from('runs').select('*').order('created_at', { ascending: false });
    if(projectId) query = query.eq('project_id', projectId);
    const { data, error } = await query;
    if(error) return res.status(500).json({ error: error.message });
    res.json({ runs: data || [] });
  } catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get single run and its logs
app.get('/api/runs/:id', verifyUser, async (req, res) => {
  try {
    if(!req.user) return res.status(401).json({ error: 'not_authenticated' });
    const runId = req.params.id;
    const { data: run, error: runErr } = await supabase.from('runs').select('*').eq('id', runId).single();
    if(runErr) return res.status(404).json({ error: runErr.message });
    // ensure ownership: fetch project and verify owner
    const { data: project } = await supabase.from('projects').select('owner').eq('id', run.project_id).single();
    if(project?.owner !== req.user.id) return res.status(403).json({ error: 'forbidden' });

    const { data: logs } = await supabase.from('run_logs').select('*').eq('run_id', runId).order('ts', { ascending: true });
    res.json({ run, logs: logs || [] });
  } catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Append log (server-side helper endpoint) — restricted to server-to-server usage if desired
app.post('/api/logs/:runId', async (req, res) => {
  try {
    const runId = req.params.runId;
    const { level = 'info', message = '' } = req.body;
    if(!message) return res.status(400).json({ error: 'message required' });
    const { data, error } = await supabase.from('run_logs').insert([{ run_id: runId, level, message }]).select().single();
    if(error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, log: data });
  } catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create deploy: upsert project (owner = current user), create run and simulate build in background
app.post('/api/deploy', verifyUser, async (req, res) => {
  try {
    if(!req.user) return res.status(401).json({ error: 'not_authenticated' });
    const payload = req.body.payload || req.body;
    if(!payload || !payload.name) return res.status(400).json({ error: 'payload.name required' });

    // check existing project
    const { data: existing } = await supabase.from('projects').select('*').eq('name', payload.name).limit(1).maybeSingle();

    let project;
    if(!existing){
      const { data: inserted, error: insertErr } = await supabase.from('projects').insert([{
        name: payload.name,
        repo: payload.repo || '',
        framework: payload.framework || '',
        region: payload.region || '',
        domain: (payload.name || '').replace(/\s+/g,'-') + '.dexpress.app',
        visitors: 0,
        owner: req.user.id
      }]).select().single();
      if(insertErr) throw insertErr;
      project = inserted;
    } else {
      // update owner if missing
      project = existing;
      if(!project.owner){
        await supabase.from('projects').update({ owner: req.user.id }).eq('id', project.id);
        project.owner = req.user.id;
      }
      // optional update
      await supabase.from('projects').update({
        repo: payload.repo || project.repo,
        framework: payload.framework || project.framework,
        region: payload.region || project.region
      }).eq('id', project.id);
    }

    // create run
    const { data: run } = await supabase.from('runs').insert([{
      project_id: project.id,
      status: 'queued',
      started_at: new Date().toISOString()
    }]).select().single();

    // enqueue background simulation (fire-and-forget)
    simulateBuild(run.id, project).catch(err => console.error('simulateBuild err', err));

    res.json({ runId: run.id, projectId: project.id, status: 'queued' });

  } catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Simple build simulator (server-side). Replace with real CI/CD/runner.
async function simulateBuild(runId, project){
  try {
    await supabase.from('runs').update({ status: 'running' }).eq('id', runId);
    await supabase.from('run_logs').insert([
      { run_id: runId, level: 'info', message: 'Build queued' }
    ]);
    const steps = ['Cloning repo','Installing dependencies','Building assets','Running tests','Packaging','Uploading','Activating services'];
    for(let i=0;i<steps.length;i++){
      await supabase.from('run_logs').insert([{ run_id: runId, level: 'info', message: steps[i] + '...' }]);
      await sleep(700 + Math.floor(Math.random()*1000));
    }
    const buildTime = Math.floor(10 + Math.random()*40) + 's';
    await supabase.from('runs').update({ status: 'success', finished_at: new Date().toISOString(), build_time: buildTime }).eq('id', runId);
    await supabase.from('run_logs').insert([{ run_id: runId, level: 'info', message: 'Build finished successfully in ' + buildTime }]);
    // increase visitors count (best-effort)
    await supabase.rpc('increment_visitors', { proj_id: project.id }).catch(() => {});
  } catch(err){
    console.error('simulateBuild error', err);
    await supabase.from('runs').update({ status: 'failed', finished_at: new Date().toISOString() }).eq('id', runId);
    await supabase.from('run_logs').insert([{ run_id: runId, level: 'error', message: 'Build failed: ' + String(err.message) }]);
  }
}

function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

// OPTIONAL Chat endpoint: proxies to OpenAI if OPENAI_API_KEY is set.
// To enable, set OPENAI_API_KEY in .env. The frontend can post { messages: [{ role, content }], model }.
app.post('/api/chat', async (req, res) => {
  if(!OPENAI_API_KEY) return res.status(501).json({ error: 'CHAT_NOT_CONFIGURED' });
  const body = req.body;
  if(!body?.messages) return res.status(400).json({ error: 'messages required' });
  const model = body.model || 'gpt-4o-mini';
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: body.messages,
        max_tokens: body.max_tokens || 600
      })
    });
    const data = await resp.json();
    res.json(data);
  } catch(err){
    console.error('chat proxy error', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
