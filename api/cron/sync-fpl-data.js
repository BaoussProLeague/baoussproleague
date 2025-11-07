// api/cron/sync-fpl-data.js - FIXED VERSION with comprehensive error logging
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
let supabase;
try {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('[FATAL] Missing Supabase credentials');
  } else {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );
    console.log('[INIT] Supabase client initialized');
  }
} catch (error) {
  console.error('[FATAL] Supabase initialization error:', error.message);
}

const CONFIG = {
  classicLeagueId: 1229613,
  lmsLeagueId: 1190208,
  h2hLeagueId: 1190166
};

async function fetchFPL(endpoint) {
  const url = `https://fantasy.premierleague.com/api${endpoint}`;
  console.log(`[FPL] Fetching: ${url}`);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      'Accept': 'application/json'
    }
  });
  if (!response.ok) {
    throw new Error(`FPL API ${endpoint} returned ${response.status}`);
  }
  return response.json();
}

async function getCurrentGW() {
  try {
    const bootstrap = await fetchFPL('/bootstrap-static/');
    return bootstrap.events.find(e => e.is_current)?.id || 11;
  } catch (error) {
    console.error('[ERROR] getCurrentGW:', error.message);
    return 11;
  }
}

async function fetchAllManagers(leagueId, leagueName) {
  const managers = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      console.log(`[${leagueName}] Fetching page ${page}`);
      const data = await fetchFPL(`/leagues-classic/${leagueId}/standings/?page_standings=${page}`);
      
      if (data.standings?.results) {
        managers.push(...data.standings.results);
        hasMore = data.standings.has_next;
        page++;
      } else {
        hasMore = false;
      }
    } catch (error) {
      console.error(`[ERROR] Fetch ${leagueName} page ${page}:`, error.message);
      hasMore = false;
    }
  }

  console.log(`[${leagueName}] Total managers: ${managers.length}`);
  return managers;
}

export default async function handler(req, res) {
  const startTime = Date.now();
  console.log('\n=== FPL Sync Started ===');
  console.log('[TIME]', new Date().toISOString());

  // Check CRON_SECRET
  const cronSecret = req.headers['x-vercel-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '');
  if (cronSecret !== process.env.CRON_SECRET) {
    console.error('[AUTH] Invalid CRON_SECRET');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Check Supabase
    if (!supabase) {
      throw new Error('Supabase client not initialized');
    }

    const currentGW = await getCurrentGW();
    console.log('[GW] Current:', currentGW);

    // Fetch all leagues
    const [classicManagers, lmsManagers, h2hManagers] = await Promise.all([
      fetchAllManagers(CONFIG.classicLeagueId, 'Classic'),
      fetchAllManagers(CONFIG.lmsLeagueId, 'LMS'),
      fetchAllManagers(CONFIG.h2hLeagueId, 'H2H')
    ]);

    // Prepare manager data
    const managerData = classicManagers.map(m => ({
      manager_id: m.entry,
      manager_name: m.player_name,
      team_name: m.entry_name,
      gw: currentGW,
      gw_points: m.event_total || 0,
      total_points: m.total || 0,
      overall_rank: m.rank || 0,
      last_updated: new Date().toISOString()
    }));

    // Insert into Supabase
    console.log(`[DB] Inserting ${managerData.length} manager records`);
    const { data, error } = await supabase
      .from('manager_data')
      .upsert(managerData, { onConflict: 'manager_id,gw' });

    if (error) {
      throw new Error(`Supabase insert failed: ${error.message}`);
    }

    const duration = Date.now() - startTime;
    console.log(`[SUCCESS] Sync completed in ${duration}ms`);
    console.log('=== FPL Sync Ended ===\n');

    return res.status(200).json({
      success: true,
      gw: currentGW,
      managersProcessed: managerData.length,
      duration: `${duration}ms`
    });

  } catch (error) {
    console.error('[FATAL ERROR]', error.message);
    console.error('[STACK]', error.stack);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
