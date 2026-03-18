// server.js — Express backend using Neon (PostgreSQL via pg)
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');

// multer: store uploads in memory (Vercel has no persistent disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

dotenv.config();

const PORT = process.env.PORT || 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL in environment. See .env.example');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

function nowISO() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get('/health', (req, res) => res.json({ ok: true, now: nowISO() }));

// Validate a GitHub repo URL and return metadata
app.post('/api/validate-repo', async (req, res) => {
  const { repo } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo required' });

  // must be a github.com URL
  const match = repo.match(/github\.com\/([^/]+)\/([^/\s]+)/);
  if (!match) return res.status(400).json({ valid: false, error: 'Not a valid GitHub URL' });

  const [, owner, repoName] = match;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repoName.replace(/\.git$/, '')}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'dexpress-app' }
    });
    if (resp.status === 404) return res.status(200).json({ valid: false, error: 'Repository not found or is private' });
    if (!resp.ok) return res.status(200).json({ valid: false, error: `GitHub API error: ${resp.status}` });
    const data = await resp.json();
    res.json({
      valid: true,
      meta: {
        fullName: data.full_name,
        description: data.description,
        language: data.language,
        stars: data.stargazers_count,
        defaultBranch: data.default_branch,
        private: data.private
      }
    });
  } catch (err) {
    res.status(200).json({ valid: false, error: 'Could not reach GitHub: ' + err.message });
  }
});

// Serve HTML pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'welcome.html')));
app.get('/welcome.html', (req, res) => res.sendFile(path.join(__dirname, 'welcome.html')));
app.get('/log.html', (req, res) => res.sendFile(path.join(__dirname, 'log.html')));
app.get('/main.html', (req, res) => res.sendFile(path.join(__dirname, 'main.html')));
app.get('/logo.mp4', (req, res) => res.sendFile(path.join(__dirname, 'logo.mp4')));
app.get('/rock.png', (req, res) => res.sendFile(path.join(__dirname, 'rock.png')));

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
    res.json({ projects: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get runs (optionally filtered by project_id)
app.get('/api/runs', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    let result;
    if (projectId) {
      result = await pool.query('SELECT * FROM runs WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
    } else {
      result = await pool.query('SELECT * FROM runs ORDER BY created_at DESC');
    }
    res.json({ runs: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get single run and its logs
app.get('/api/runs/:id', async (req, res) => {
  try {
    const { rows: runRows } = await pool.query('SELECT * FROM runs WHERE id = $1', [req.params.id]);
    if (!runRows.length) return res.status(404).json({ error: 'run not found' });
    const run = runRows[0];
    const { rows: logs } = await pool.query('SELECT * FROM run_logs WHERE run_id = $1 ORDER BY ts ASC', [run.id]);
    res.json({ run, logs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Append log
app.post('/api/logs/:runId', async (req, res) => {
  try {
    const { level = 'info', message = '' } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const { rows } = await pool.query(
      'INSERT INTO run_logs (run_id, level, message) VALUES ($1, $2, $3) RETURNING *',
      [req.params.runId, level, message]
    );
    res.json({ ok: true, log: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create deploy — accepts JSON body OR multipart file upload
app.post('/api/deploy', upload.single('projectFile'), async (req, res) => {
  try {
    // support both multipart and JSON
    const payload = req.body.payload ? JSON.parse(req.body.payload) : req.body;
    if (!payload || !payload.name) return res.status(400).json({ error: 'payload.name required' });

    const hasFile = !!req.file;
    const fileInfo = hasFile ? { name: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype } : null;

    // validate repo only if provided (file upload skips repo validation)
    if (payload.repo && !hasFile) {
      const urlPattern = /^https?:\/\/.+/;
      if (!urlPattern.test(payload.repo)) {
        return res.status(400).json({ error: 'Invalid repository URL.' });
      }
      // GitHub-specific validation
      const ghMatch = payload.repo.match(/github\.com\/([^/]+)\/([^/\s]+)/);
      if (ghMatch) {
        const [, owner, repoName] = ghMatch;
        const ghResp = await fetch(`https://api.github.com/repos/${owner}/${repoName.replace(/\.git$/, '')}`, {
          headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'dexpress-app' }
        });
        if (ghResp.status === 404) return res.status(400).json({ error: 'Repository not found or is private on GitHub.' });
        if (!ghResp.ok) return res.status(400).json({ error: `GitHub validation failed: ${ghResp.status}` });
        const ghData = await ghResp.json();
        if (!payload.framework || payload.framework === 'Auto-detect') {
          const langMap = { JavaScript: 'Node', TypeScript: 'Next.js', Python: 'Python', Ruby: 'Ruby' };
          payload.framework = langMap[ghData.language] || ghData.language || 'Auto-detect';
        }
      }
    }

    if (!payload.repo && !hasFile) {
      return res.status(400).json({ error: 'Deployment failed: Please provide a repository URL or upload project files.' });
    }

    // upsert project
    const { rows: existing } = await pool.query('SELECT * FROM projects WHERE name = $1 LIMIT 1', [payload.name]);
    let project;
    if (!existing.length) {
      const { rows } = await pool.query(
        `INSERT INTO projects (name, repo, framework, region, domain, visitors)
         VALUES ($1, $2, $3, $4, $5, 0) RETURNING *`,
        [
          payload.name,
          payload.repo || '',
          payload.framework || '',
          payload.region || '',
          (payload.name || '').replace(/\s+/g, '-') + '.dexpress.app'
        ]
      );
      project = rows[0];
    } else {
      project = existing[0];
      await pool.query(
        'UPDATE projects SET repo=$1, framework=$2, region=$3 WHERE id=$4',
        [payload.repo || project.repo, payload.framework || project.framework, payload.region || project.region, project.id]
      );
    }

    // create run
    const { rows: runRows } = await pool.query(
      `INSERT INTO runs (project_id, status, started_at) VALUES ($1, 'queued', $2) RETURNING *`,
      [project.id, nowISO()]
    );
    const run = runRows[0];

    simulateBuild(run.id, project, fileInfo).catch(err => console.error('simulateBuild err', err));

    res.json({ runId: run.id, projectId: project.id, status: 'queued' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

async function simulateBuild(runId, project, fileInfo = null) {
  try {
    await pool.query("UPDATE runs SET status='running' WHERE id=$1", [runId]);
    await pool.query('INSERT INTO run_logs (run_id, level, message) VALUES ($1, $2, $3)', [runId, 'info', 'Build queued']);

    if (fileInfo) {
      await pool.query('INSERT INTO run_logs (run_id, level, message) VALUES ($1, $2, $3)', [runId, 'info', `Received uploaded file: ${fileInfo.name} (${(fileInfo.size/1024).toFixed(1)} KB)`]);
      await pool.query('INSERT INTO run_logs (run_id, level, message) VALUES ($1, $2, $3)', [runId, 'info', 'Extracting project files...']);
    } else {
      await pool.query('INSERT INTO run_logs (run_id, level, message) VALUES ($1, $2, $3)', [runId, 'info', `Cloning repo: ${project.repo}`]);
    }
    const steps = fileInfo
      ? ['Validating files', 'Installing dependencies', 'Building assets', 'Running tests', 'Packaging', 'Uploading', 'Activating services']
      : ['Installing dependencies', 'Building assets', 'Running tests', 'Packaging', 'Uploading', 'Activating services'];
    for (const step of steps) {
      await pool.query('INSERT INTO run_logs (run_id, level, message) VALUES ($1, $2, $3)', [runId, 'info', step + '...']);
      await sleep(700 + Math.floor(Math.random() * 1000));
    }
    const buildTime = Math.floor(10 + Math.random() * 40) + 's';
    await pool.query(
      "UPDATE runs SET status='success', finished_at=$1, build_time=$2 WHERE id=$3",
      [nowISO(), buildTime, runId]
    );
    await pool.query('INSERT INTO run_logs (run_id, level, message) VALUES ($1, $2, $3)', [runId, 'info', 'Build finished successfully in ' + buildTime]);
    await pool.query('UPDATE projects SET visitors = visitors + 1 WHERE id=$1', [project.id]);
  } catch (err) {
    console.error('simulateBuild error', err);
    await pool.query("UPDATE runs SET status='failed', finished_at=$1 WHERE id=$2", [nowISO(), runId]);
    await pool.query('INSERT INTO run_logs (run_id, level, message) VALUES ($1, $2, $3)', [runId, 'error', 'Build failed: ' + String(err.message)]);
  }
}

// Optional chat proxy
app.post('/api/chat', async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(501).json({ error: 'CHAT_NOT_CONFIGURED' });
  const { messages, model = 'gpt-4o-mini', max_tokens = 600 } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens })
    });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export for Vercel serverless; also listen locally
if (process.env.NODE_ENV !== 'production' || process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
