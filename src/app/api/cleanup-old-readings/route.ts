import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const { retentionDays } = await request.json();

    if (!retentionDays || retentionDays < 1) {
      return NextResponse.json(
        { error: 'retentionDays must be at least 1' },
        { status: 400 }
      );
    }

    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // Count how many readings will be deleted
    const { count: countToDelete } = await supabase
      .from('temperature_readings')
      .select('*', { count: 'exact', head: true })
      .lt('ts_utc', cutoffDate.toISOString());

    // Delete old readings
    const { error } = await supabase
      .from('temperature_readings')
      .delete()
      .lt('ts_utc', cutoffDate.toISOString());

    if (error) {
      console.error('Cleanup error:', error);
      return NextResponse.json(
        { error: 'Failed to delete old readings', details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      deleted: countToDelete || 0,
      cutoffDate: cutoffDate.toISOString(),
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    return NextResponse.json(
      { error: 'Failed to cleanup old readings', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// GET endpoint to get statistics about data
export async function GET() {
  try {
    // Get total count
    const { count: totalCount } = await supabase
      .from('temperature_readings')
      .select('*', { count: 'exact', head: true });

    // Get oldest reading
    const { data: oldestData } = await supabase
      .from('temperature_readings')
      .select('ts_utc')
      .order('ts_utc', { ascending: true })
      .limit(1);

    // Get newest reading
    const { data: newestData } = await supabase
      .from('temperature_readings')
      .select('ts_utc')
      .order('ts_utc', { ascending: false })
      .limit(1);

    // Get counts by age
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const { count: last7Days } = await supabase
      .from('temperature_readings')
      .select('*', { count: 'exact', head: true })
      .gte('ts_utc', sevenDaysAgo.toISOString());

    const { count: last30Days } = await supabase
      .from('temperature_readings')
      .select('*', { count: 'exact', head: true })
      .gte('ts_utc', thirtyDaysAgo.toISOString());

    return NextResponse.json({
      totalCount: totalCount || 0,
      oldestReading: oldestData?.[0]?.ts_utc || null,
      newestReading: newestData?.[0]?.ts_utc || null,
      last7Days: last7Days || 0,
      last30Days: last30Days || 0,
      olderThan30Days: (totalCount || 0) - (last30Days || 0),
    });
  } catch (error) {
    console.error('Stats error:', error);
    return NextResponse.json(
      { error: 'Failed to get statistics', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
