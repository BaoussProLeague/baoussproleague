// api/sync-fpl-data.js - Vercel Cron Job to sync FPL data to Supabase

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const CONFIG = {
  classicLeagueId: 1229613,
  lmsLeagueId: 1190208,
  h2hLeagueId: 1190166
};

async function fetchFPL(endpoint) {
  const response = await fetch(`https://fantasy.premierleague.com/api${endpoint}`);
  if (!response.ok) throw new Error(`FPL API error: ${response.status}`);
  return response.json();
}

async function getCurrentGW() {
  try {
    const bootstrap = await fetchFPL('/bootstrap-static/');
    return bootstrap.events.find(e => e.is_current)?.id || 11;
  } catch (error) {
    console.error('Error detecting current GW:', error);
    return 11;
  }
}

async function getAllManagersFromLeague(leagueId, pageStandings = 1) {
  const managers = [];
  try {
    const response = await fetchFPL(`/leagues-classic/${leagueId}/standings/?page_standings=${pageStandings}`);
    
    if (response.standings?.results) {
      managers.push(...response.standings.results);
    }
    
    // Check if there's more pages
    if (response.standings?.has_next) {
      const nextPageManagers = await getAllManagersFromLeague(leagueId, pageStandings + 1);
      managers.push(...nextPageManagers);
    }
    
    return managers;
  } catch (error) {
    console.error(`Error fetching league ${leagueId}:`, error);
    return managers;
  }
}

async function getManagerDetails(managerId) {
  try {
    const response = await fetchFPL(`/entry/${managerId}/`);
    return response;
  } catch (error) {
    console.error(`Error fetching manager ${managerId}:`, error);
    return null;
  }
}

async function getManagerGWPicks(managerId, gw) {
  try {
    const response = await fetchFPL(`/entry/${managerId}/event/${gw}/picks/`);
    return response;
  } catch (error) {
    console.error(`Error fetching picks for manager ${managerId}:`, error);
    return null;
  }
}

async function syncManagerData() {
  console.log('📥 Starting FPL data sync...');
  
  try {
    const currentGW = await getCurrentGW();
    console.log(`Current GW: ${currentGW}`);
    
    // Fetch all managers from classic league (all pages)
    const allManagers = await getAllManagersFromLeague(CONFIG.classicLeagueId);
    console.log(`Found ${allManagers.length} managers`);
    
    if (allManagers.length === 0) {
      return { success: false, message: 'No managers found' };
    }
    
    // Sync each manager
    for (const manager of allManagers) {
      try {
        const details = await getManagerDetails(manager.entry);
        if (!details) continue;
        
        // Get current GW picks for captain info
        const picks = await getManagerGWPicks(manager.entry, currentGW);
        const captain = picks?.picks?.find(p => p.is_captain);
        const captainId = captain?.element || null;
        
        // Upsert to Supabase
        await supabase.from('manager_data').upsert({
          manager_id: manager.entry,
          entry_id: manager.entry,
          manager_name: manager.player_name,
          team_name: manager.entry_name,
          total_points: manager.total,
          overall_rank: manager.rank,
          gw_points: manager.event_total || 0,
          captain_id: captainId,
          captain_name: details.last_name || 'Unknown',
          value: details.value || 0,
          bank: details.bank || 0,
          transfers_made: details.transfers_made || 0,
          last_updated: new Date().toISOString()
        }, { onConflict: 'manager_id' });
      } catch (error) {
        console.error(`Error syncing manager ${manager.entry}:`, error);
      }
    }
    
    // Update current GW
    await supabase.from('season_snapshot').upsert({
      id: 1,
      current_gw: currentGW,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    
    console.log('✅ Sync completed');
    return { success: true, managers: allManagers.length, gw: currentGW };
    
  } catch (error) {
    console.error('Sync failed:', error);
    return { success: false, error: error.message };
  }
}

export default async function handler(req, res) {
  // Verify this is a cron request from Vercel
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const result = await syncManagerData();
  res.status(200).json(result);
}
