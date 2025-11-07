// Diagnostic Test Endpoint - No Auth Required
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    step: 'init',
    errors: []
  };

  try {
    // Step 1: Check environment variables
    diagnostics.step = 'env_check';
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase credentials. SUPABASE_URL or SUPABASE_KEY not set');
    }
    
    diagnostics.env = {
      supabaseUrl: supabaseUrl ? 'SET' : 'MISSING',
      supabaseKey: supabaseKey ? 'SET (length: ' + supabaseKey.length + ')' : 'MISSING'
    };

    // Step 2: Initialize Supabase client
    diagnostics.step = 'supabase_init';
    const supabase = createClient(supabaseUrl, supabaseKey);
    diagnostics.supabase = 'Client initialized';

    // Step 3: Test FPL API
    diagnostics.step = 'fpl_api_test';
    const fplResponse = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
    
    if (!fplResponse.ok) {
      throw new Error(`FPL API returned ${fplResponse.status}`);
    }
    
    const fplData = await fplResponse.json();
    diagnostics.fpl = {
      status: 'SUCCESS',
      currentGW: fplData.events.find(e => e.is_current)?.id || 'Unknown'
    };

    // Step 4: Test Classic League API
    diagnostics.step = 'league_api_test';
    const leagueId = 1229613;
    const leagueUrl = `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=1`;
    const leagueResponse = await fetch(leagueUrl);
    
    if (!leagueResponse.ok) {
      throw new Error(`League API returned ${leagueResponse.status}`);
    }
    
    const leagueData = await leagueResponse.json();
    diagnostics.league = {
      status: 'SUCCESS',
      totalManagers: leagueData.standings?.results?.length || 0,
      leagueName: leagueData.league?.name || 'Unknown'
    };

    // Step 5: Test Supabase insert
    diagnostics.step = 'supabase_insert';
    const testData = {
      manager_id: 999999,
      manager_name: 'TEST_DIAGNOSTIC',
      team_name: 'Test Team',
      gw: diagnostics.fpl.currentGW,
      gw_points: 0,
      total_points: 0,
      overall_rank: 999999,
      last_updated: new Date().toISOString()
    };

    const { data: insertData, error: insertError } = await supabase
      .from('manager_data')
      .upsert(testData, { onConflict: 'manager_id,gw' });

    if (insertError) {
      throw new Error('Supabase insert failed: ' + insertError.message);
    }

    diagnostics.supabase_insert = 'SUCCESS';

    // Step 6: Verify data exists
    const { data: verifyData, error: verifyError } = await supabase
      .from('manager_data')
      .select('*')
      .eq('manager_id', 999999)
      .single();

    if (verifyError && verifyError.code !== 'PGRST116') {
      throw new Error('Supabase query failed: ' + verifyError.message);
    }

    diagnostics.supabase_verify = verifyData ? 'DATA FOUND' : 'NO DATA';

    // Success!
    return res.status(200).json({
      success: true,
      message: 'All diagnostic tests passed!',
      diagnostics
    });

  } catch (error) {
    diagnostics.errors.push({
      step: diagnostics.step,
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: error.message,
      diagnostics
    });
  }
}
