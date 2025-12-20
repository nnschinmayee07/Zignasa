// supabaseClient.js
// Optional helper for other scripts to init the supabase client (server-side)
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if(!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_KEY');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false }});
module.exports = supabase;
