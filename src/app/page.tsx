"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type Reading = {
  device_id: string;
  sensor_id: string;
  sensor_name: string;
  temp_c: number;
  ts_utc: string;
};

const DEVICE_ID = process.env.NEXT_PUBLIC_DEVICE_ID || "pi4";
const TIME_ZONE = "America/Chicago";
const APP_VERSION = "1.7.0"; // Application version

function formatChicago(isoUtc: string) {
  const d = new Date(isoUtc);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(d);
}

function formatChicagoDate(isoUtc: string) {
  const d = new Date(isoUtc);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function formatChicagoTime(isoUtc: string) {
  const d = new Date(isoUtc);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(d);
}

function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9/5) + 32;
}

function getSensorColor(sensorName: string): string {
  if (sensorName === 'ambient') return '#ffffff';
  if (sensorName === 'test_probe') return '#ef5350';
  if (sensorName === 'control_probe') return '#66bb6a';
  if (sensorName === 'outdoor') return '#64b5f6';
  return '#64b5f6'; // default color
}

export default function Home() {
  const [latestBySensor, setLatestBySensor] = useState<Record<string, Reading>>(
    {}
  );
  const [status, setStatus] = useState<string>("Connecting…");

  // --- Time range tracking ---
  const [startDate, setStartDate] = useState<string>("");
  const [startTime, setStartTime] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [endTime, setEndTime] = useState<string>("");
  const [filteredReadings, setFilteredReadings] = useState<Reading[]>([]);
  const [isTracking, setIsTracking] = useState<boolean>(false);
  const [useManualTime, setUseManualTime] = useState<boolean>(true);
  const [trackingCompleted, setTrackingCompleted] = useState<boolean>(false);
  const [trackingStartTime, setTrackingStartTime] = useState<string>("");
  const [trackingEndTime, setTrackingEndTime] = useState<string>("");
  const [lastSaveTime, setLastSaveTime] = useState<string>("");
  const [emailAddress, setEmailAddress] = useState<string>("");
  const [autoEmailEnabled, setAutoEmailEnabled] = useState<boolean>(false);
  const [emailSending, setEmailSending] = useState<boolean>(false);
  const [samplingInterval, setSamplingInterval] = useState<number>(30);
  const [samplingIntervalUnit, setSamplingIntervalUnit] = useState<"seconds" | "minutes" | "hours">("seconds");

  // Database cleanup state
  const [dbStats, setDbStats] = useState<{
    totalCount: number;
    oldestReading: string | null;
    newestReading: string | null;
    last7Days: number;
    last30Days: number;
    olderThan30Days: number;
  } | null>(null);
  const [cleanupInProgress, setCleanupInProgress] = useState<boolean>(false);

  // Outdoor weather state (ZIP 53224 - Milwaukee, WI)
  const [outdoorTemp, setOutdoorTemp] = useState<number | null>(null);
  const [outdoorLastUpdate, setOutdoorLastUpdate] = useState<string | null>(null);
  const [outdoorReadings, setOutdoorReadings] = useState<Array<{ temp_c: number; ts_utc: string }>>([]);

  // Hardcoded upload interval (Pi's actual upload rate)
  const uploadIntervalInSeconds = 10;
  const offlineThreshold = uploadIntervalInSeconds * 4; // 40 seconds

  // Calculate sampling interval in seconds
  const samplingIntervalInSeconds = useMemo(() => {
    switch (samplingIntervalUnit) {
      case "minutes":
        return samplingInterval * 60;
      case "hours":
        return samplingInterval * 3600;
      default:
        return samplingInterval;
    }
  }, [samplingInterval, samplingIntervalUnit]);

  // --- Refs to track current values in callbacks ---
  const isTrackingRef = useRef(isTracking);
  const trackingStartTimeRef = useRef(trackingStartTime);
  const trackingEndTimeRef = useRef(trackingEndTime);

  // Update refs when state changes
  useEffect(() => {
    isTrackingRef.current = isTracking;
  }, [isTracking]);

  useEffect(() => {
    trackingStartTimeRef.current = trackingStartTime;
  }, [trackingStartTime]);

  useEffect(() => {
    trackingEndTimeRef.current = trackingEndTime;
  }, [trackingEndTime]);

  // --- Offline / staleness tracking ---
  const [ageSec, setAgeSec] = useState<number | null>(null);

  const lastTsUtc = useMemo(() => {
    const all = Object.values(latestBySensor);
    if (all.length === 0) return null;
    return all.reduce((max, r) =>
      new Date(r.ts_utc) > new Date(max) ? r.ts_utc : max,
      all[0].ts_utc
    );
  }, [latestBySensor]);

  const isOffline = ageSec !== null && ageSec > offlineThreshold;

  const rows = useMemo(() => {
    return Object.values(latestBySensor).sort((a, b) =>
      a.sensor_name.localeCompare(b.sensor_name)
    );
  }, [latestBySensor]);

  // Group filtered readings by sensor
  const filteredBySensor = useMemo(() => {
    const grouped: Record<string, Reading[]> = {};
    for (const reading of filteredReadings) {
      if (!grouped[reading.sensor_name]) {
        grouped[reading.sensor_name] = [];
      }
      grouped[reading.sensor_name].push(reading);
    }
    // Sort each sensor's readings by timestamp (newest first)
    for (const sensor in grouped) {
      grouped[sensor].sort((a, b) =>
        new Date(b.ts_utc).getTime() - new Date(a.ts_utc).getTime()
      );
    }
    return grouped;
  }, [filteredReadings]);

  async function loadInitial() {
    setStatus("Loading…");
    const { data, error } = await supabase
      .from("temperature_readings")
      .select("device_id,sensor_id,sensor_name,temp_c,ts_utc")
      .eq("device_id", DEVICE_ID)
      .order("ts_utc", { ascending: false })
      .limit(100);

    if (error) {
      setStatus(`Error: ${error.message}`);
      return;
    }

    const map: Record<string, Reading> = {};
    for (const r of data as Reading[]) {
      if (!map[r.sensor_name]) map[r.sensor_name] = r;
    }
    setLatestBySensor(map);
    setStatus("Live ✅");
  }

  // Start tracking temperatures for the selected time range
  async function startTracking() {
    let startDateTime: Date;
    let endDateTime: Date;

    if (useManualTime) {
      // Manual mode: require date and time inputs
      if (!startDate || !startTime || !endDate || !endTime) {
        alert("Please select start date, start time, end date, and end time");
        return;
      }

      startDateTime = new Date(`${startDate}T${startTime}:00`);
      endDateTime = new Date(`${endDate}T${endTime}:00`);

      if (endDateTime <= startDateTime) {
        alert("End date/time must be after start date/time");
        return;
      }
    } else {
      // Automatic mode: start tracking from now
      startDateTime = new Date();
      endDateTime = new Date(startDateTime.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year in the future
    }

    setIsTracking(true);
    setTrackingCompleted(false);
    setFilteredReadings([]);
    setOutdoorReadings([]);
    setTrackingStartTime(startDateTime.toISOString());
    setTrackingEndTime(endDateTime.toISOString());

    // Fetch historical data within the time range (only if in manual mode with past dates)
    if (useManualTime && startDateTime < new Date()) {
      const { data, error } = await supabase
        .from("temperature_readings")
        .select("device_id,sensor_id,sensor_name,temp_c,ts_utc")
        .eq("device_id", DEVICE_ID)
        .gte("ts_utc", startDateTime.toISOString())
        .lte("ts_utc", endDateTime.toISOString())
        .order("ts_utc", { ascending: false })
        .limit(100000);

      if (error) {
        alert(`Error fetching data: ${error.message}`);
        setIsTracking(false);
        return;
      }

      setFilteredReadings(data as Reading[]);
    }
  }

  // Stop tracking and clear the time range
  function stopTracking() {
    setIsTracking(false);
    setTrackingCompleted(true);

    // Update end time to now if in auto mode
    if (!useManualTime) {
      setTrackingEndTime(new Date().toISOString());
    }

    // Auto-send email if enabled
    if (autoEmailEnabled && emailAddress && filteredReadings.length > 0) {
      // Use setTimeout to ensure state updates have completed
      setTimeout(() => {
        exportToHTML(true);
      }, 100);
    }
  }

  // Clear all tracking data and reset
  function clearTracking() {
    setIsTracking(false);
    setTrackingCompleted(false);
    setFilteredReadings([]);
    setOutdoorReadings([]);
    setTrackingStartTime("");
    setTrackingEndTime("");
    if (useManualTime) {
      setStartDate("");
      setStartTime("");
      setEndDate("");
      setEndTime("");
    }
  }

  // Fetch database statistics
  async function fetchDbStats() {
    try {
      const response = await fetch('/api/cleanup-old-readings');
      const data = await response.json();

      if (response.ok) {
        setDbStats(data);
      } else {
        alert(`Failed to fetch database stats: ${data.error}`);
      }
    } catch (error) {
      console.error('Error fetching database stats:', error);
      alert('Failed to fetch database statistics');
    }
  }

  // Cleanup old readings
  async function cleanupOldReadings() {
    const daysInput = prompt(
      "Delete readings older than how many days?\n\n" +
      "Recommended: 7-30 days for regular cleanup\n" +
      "Note: This action cannot be undone!",
      "30"
    );

    if (!daysInput) return; // User cancelled

    const days = parseInt(daysInput);
    if (isNaN(days) || days < 1) {
      alert("Please enter a valid number of days (minimum 1)");
      return;
    }

    const confirm = window.confirm(
      `Are you sure you want to delete all readings older than ${days} days?\n\n` +
      `This will permanently remove the data and cannot be undone.`
    );

    if (!confirm) return;

    setCleanupInProgress(true);

    try {
      const response = await fetch('/api/cleanup-old-readings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ retentionDays: days }),
      });

      const data = await response.json();

      if (response.ok) {
        alert(
          `Successfully deleted ${data.deleted} readings!\n\n` +
          `Cutoff date: ${formatChicago(data.cutoffDate)}`
        );
        // Refresh stats after cleanup
        fetchDbStats();
      } else {
        alert(`Failed to cleanup: ${data.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Cleanup error:', error);
      alert('Failed to cleanup old readings');
    } finally {
      setCleanupInProgress(false);
    }
  }

  // Fetch outdoor weather for ZIP 53224 (Milwaukee, WI: 43.0731°N, 87.9065°W)
  async function fetchOutdoorWeather() {
    try {
      const lat = 43.0731;
      const lon = -87.9065;
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&temperature_unit=celsius`
      );
      const data = await response.json();

      if (data.current && data.current.temperature_2m !== undefined) {
        const timestamp = new Date().toISOString();
        setOutdoorTemp(data.current.temperature_2m);
        setOutdoorLastUpdate(timestamp);

        // If tracking is active, add to outdoor readings array
        if (isTrackingRef.current && trackingStartTimeRef.current && trackingEndTimeRef.current) {
          const readingTime = new Date(timestamp);
          const startTime = new Date(trackingStartTimeRef.current);
          const endTime = new Date(trackingEndTimeRef.current);

          if (readingTime >= startTime && readingTime <= endTime) {
            setOutdoorReadings(prev => [{
              temp_c: data.current.temperature_2m,
              ts_utc: timestamp
            }, ...prev]);
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch outdoor weather:', error);
    }
  }

  // Generate summary text for email
  function generateSummary(stats: Record<string, { min: number; max: number; avg: number; count: number }>) {
    let summary = "Temperature Readings Summary:\n\n";

    Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)).forEach(([sensor, data]) => {
      summary += `${sensor}:\n`;
      summary += `  Total Readings: ${data.count}\n`;
      summary += `  Min: ${data.min.toFixed(2)} °C\n`;
      summary += `  Max: ${data.max.toFixed(2)} °C\n`;
      summary += `  Avg: ${data.avg.toFixed(2)} °C\n\n`;
    });

    return summary;
  }

  // Send email with HTML report
  async function sendEmailReport(htmlContent: string, stats: Record<string, { min: number; max: number; avg: number; count: number }>) {
    if (!emailAddress || !emailAddress.includes('@')) {
      alert("Please enter a valid email address");
      return;
    }

    setEmailSending(true);

    try {
      const summary = generateSummary(stats);
      const timeRange = `${formatChicago(trackingStartTime)} - ${formatChicago(trackingEndTime)}`;

      // Check payload size
      const payload = {
        email: emailAddress,
        htmlContent,
        summary,
        timeRange,
      };
      const payloadSize = new Blob([JSON.stringify(payload)]).size;
      const payloadSizeMB = (payloadSize / 1024 / 1024).toFixed(2);

      console.log(`Email payload size: ${payloadSizeMB} MB`);

      // Warn if payload is very large (>4MB can fail on mobile)
      if (payloadSize > 4 * 1024 * 1024) {
        const proceed = confirm(
          `Warning: Report is very large (${payloadSizeMB} MB). This may fail on mobile networks. ` +
          `Try reducing the date range or increasing the sampling interval.\n\n` +
          `Continue anyway?`
        );
        if (!proceed) {
          setEmailSending(false);
          return;
        }
      }

      // Create AbortController for timeout (60 seconds for large reports)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const response = await fetch('/api/send-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json();

      if (response.ok) {
        alert(`Email sent successfully to ${emailAddress}!`);
      } else {
        const errorMsg = data.details || data.error || 'Unknown error';
        alert(`Failed to send email: ${errorMsg}`);
      }
    } catch (error) {
      console.error('Email send error:', error);

      // Better error messages for common issues
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          errorMessage = 'Request timed out. The report may be too large or the server is slow. Try reducing the date range or sampling interval.';
        } else if (error.message === 'Load failed' || error.message.includes('fetch')) {
          errorMessage = 'Network error. The report may be too large for your device or network. Try reducing the date range or increasing the sampling interval to fewer data points.';
        } else {
          errorMessage = error.message;
        }
      }

      alert(`Failed to send email: ${errorMessage}`);
    } finally {
      setEmailSending(false);
    }
  }

  // Export tracked readings to HTML
  function exportToHTML(autoSend = false) {
    if (filteredReadings.length === 0) {
      alert("No readings to export");
      return;
    }

    // Sort readings by timestamp (oldest first)
    const sortedReadings = [...filteredReadings].sort(
      (a, b) => new Date(a.ts_utc).getTime() - new Date(b.ts_utc).getTime()
    );

    // Apply sampling interval filter - keep readings closest to each interval boundary
    const samplingIntervalMs = samplingIntervalInSeconds * 1000;
    const startTimeMs = new Date(trackingStartTime).getTime();
    const endTimeMs = new Date(trackingEndTime).getTime();

    // Group readings by sensor first
    const readingsBySensor: Record<string, Reading[]> = {};
    sortedReadings.forEach((reading) => {
      if (!readingsBySensor[reading.sensor_name]) {
        readingsBySensor[reading.sensor_name] = [];
      }
      readingsBySensor[reading.sensor_name].push(reading);
    });

    // Sample each sensor separately
    const sampledReadings: Reading[] = [];
    Object.values(readingsBySensor).forEach((sensorReadings) => {
      // Calculate expected sample times
      let currentSampleTime = startTimeMs;

      while (currentSampleTime <= endTimeMs) {
        // Find the reading closest to this sample time
        let closestReading: Reading | null = null;
        let closestDiff = Infinity;

        sensorReadings.forEach((reading) => {
          const readingTime = new Date(reading.ts_utc).getTime();
          const diff = Math.abs(readingTime - currentSampleTime);

          if (diff < closestDiff && diff < samplingIntervalMs) {
            closestDiff = diff;
            closestReading = reading;
          }
        });

        if (closestReading && !sampledReadings.includes(closestReading)) {
          sampledReadings.push(closestReading);
        }

        currentSampleTime += samplingIntervalMs;
      }
    });

    // Sort sampled readings by timestamp
    sampledReadings.sort((a, b) => new Date(a.ts_utc).getTime() - new Date(b.ts_utc).getTime());

    // Use sampled readings for the report
    const reportReadings = sampledReadings.length > 0 ? sampledReadings : sortedReadings;

    // Group by sensor for summary stats (use sampled readings)
    const stats: Record<string, { min: number; max: number; avg: number; count: number }> = {};
    reportReadings.forEach((r) => {
      if (!stats[r.sensor_name]) {
        stats[r.sensor_name] = { min: r.temp_c, max: r.temp_c, avg: 0, count: 0 };
      }
      stats[r.sensor_name].min = Math.min(stats[r.sensor_name].min, r.temp_c);
      stats[r.sensor_name].max = Math.max(stats[r.sensor_name].max, r.temp_c);
      stats[r.sensor_name].avg += r.temp_c;
      stats[r.sensor_name].count++;
    });

    Object.keys(stats).forEach((sensor) => {
      stats[sensor].avg = stats[sensor].avg / stats[sensor].count;
    });

    // Separate readings by sensor (use sampled data for charts/tables)
    const ambientReadings = reportReadings.filter(r => r.sensor_name === 'ambient');
    const testProbeReadings = reportReadings.filter(r => r.sensor_name === 'test_probe');
    const controlProbeReadings = reportReadings.filter(r => r.sensor_name === 'control_probe');

    // Prepare chart data for ambient (both Celsius and Fahrenheit)
    const ambientLabels = ambientReadings.map(r => formatChicago(r.ts_utc));
    const ambientTempsC = ambientReadings.map(r => Number(r.temp_c));
    const ambientTempsF = ambientReadings.map(r => celsiusToFahrenheit(Number(r.temp_c)));

    // Prepare chart data for test_probe (both Celsius and Fahrenheit)
    const testProbeLabels = testProbeReadings.map(r => formatChicago(r.ts_utc));
    const testProbeTempsC = testProbeReadings.map(r => Number(r.temp_c));
    const testProbeTempsF = testProbeReadings.map(r => celsiusToFahrenheit(Number(r.temp_c)));

    // Prepare chart data for control_probe (both Celsius and Fahrenheit)
    const controlProbeLabels = controlProbeReadings.map(r => formatChicago(r.ts_utc));
    const controlProbeTempsC = controlProbeReadings.map(r => Number(r.temp_c));
    const controlProbeTempsF = controlProbeReadings.map(r => celsiusToFahrenheit(Number(r.temp_c)));

    // Process outdoor weather readings - sample them at the same interval
    const sampledOutdoorReadings: Array<{ temp_c: number; ts_utc: string }> = [];
    if (outdoorReadings.length > 0) {
      const sortedOutdoor = [...outdoorReadings].sort((a, b) => new Date(a.ts_utc).getTime() - new Date(b.ts_utc).getTime());
      const startTimeMs = new Date(trackingStartTime).getTime();
      const endTimeMs = new Date(trackingEndTime).getTime();
      let currentSampleTime = startTimeMs;

      while (currentSampleTime <= endTimeMs) {
        let closestReading: typeof sortedOutdoor[0] | null = null;
        let closestDiff = Infinity;

        sortedOutdoor.forEach((reading) => {
          const readingTime = new Date(reading.ts_utc).getTime();
          const diff = Math.abs(readingTime - currentSampleTime);

          if (diff < closestDiff && diff < samplingIntervalMs) {
            closestDiff = diff;
            closestReading = reading;
          }
        });

        if (closestReading && !sampledOutdoorReadings.includes(closestReading)) {
          sampledOutdoorReadings.push(closestReading);
        }

        currentSampleTime += samplingIntervalMs;
      }
    }

    // Add outdoor stats if we have readings
    if (sampledOutdoorReadings.length > 0) {
      stats['outdoor'] = {
        min: Math.min(...sampledOutdoorReadings.map(r => r.temp_c)),
        max: Math.max(...sampledOutdoorReadings.map(r => r.temp_c)),
        avg: sampledOutdoorReadings.reduce((sum, r) => sum + r.temp_c, 0) / sampledOutdoorReadings.length,
        count: sampledOutdoorReadings.length
      };
    }

    // Prepare chart data for outdoor (both Celsius and Fahrenheit)
    const outdoorLabels = sampledOutdoorReadings.map(r => formatChicago(r.ts_utc));
    const outdoorTempsC = sampledOutdoorReadings.map(r => Number(r.temp_c));
    const outdoorTempsF = sampledOutdoorReadings.map(r => celsiusToFahrenheit(Number(r.temp_c)));

    // Create HTML content
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Temperature Readings - ${formatChicago(trackingStartTime)} to ${formatChicago(trackingEndTime)}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 0;
      background: #0a0a0a;
      color: #e0e0e0;
      display: flex;
    }
    .container {
      flex: 1;
      margin-left: 280px;
      padding: 30px;
      background: #1a1a1a;
      min-height: 100vh;
    }
    h1 {
      color: #fff;
      margin-top: 0;
      font-size: 32px;
    }
    h2 {
      color: #64b5f6;
      margin-top: 40px;
      margin-bottom: 20px;
      font-size: 24px;
    }
    .metadata {
      background: #252525;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 30px;
      border: 1px solid #333;
    }
    .metadata p {
      margin: 8px 0;
      color: #b0b0b0;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    .summary-card {
      background: #1e3a5f;
      padding: 20px;
      border-radius: 8px;
      border-left: 4px solid #64b5f6;
    }
    .summary-card h3 {
      margin: 0 0 15px 0;
      color: #64b5f6;
      font-size: 18px;
    }
    .summary-card p {
      margin: 8px 0;
      font-size: 15px;
      color: #b0b0b0;
    }
    /* Sensor-specific colors */
    .ambient-color .summary-card {
      background: rgba(255, 255, 255, 0.1);
      border-left-color: #ffffff;
    }
    .ambient-color .summary-card h3 {
      color: #ffffff;
    }
    .ambient-color th {
      background: rgba(255, 255, 255, 0.2);
      color: #ffffff;
      border-bottom-color: #ffffff;
    }
    .test-probe-color .summary-card {
      background: rgba(239, 83, 80, 0.15);
      border-left-color: #ef5350;
    }
    .test-probe-color .summary-card h3 {
      color: #ef5350;
    }
    .test-probe-color th {
      background: rgba(239, 83, 80, 0.2);
      color: #ef5350;
      border-bottom-color: #ef5350;
    }
    .control-probe-color .summary-card {
      background: rgba(102, 187, 106, 0.15);
      border-left-color: #66bb6a;
    }
    .control-probe-color .summary-card h3 {
      color: #66bb6a;
    }
    .control-probe-color th {
      background: rgba(102, 187, 106, 0.2);
      color: #66bb6a;
      border-bottom-color: #66bb6a;
    }
    .outdoor-color .summary-card {
      background: rgba(100, 181, 246, 0.15);
      border-left-color: #64b5f6;
    }
    .outdoor-color .summary-card h3 {
      color: #64b5f6;
    }
    .outdoor-color th {
      background: rgba(100, 181, 246, 0.2);
      color: #64b5f6;
      border-bottom-color: #64b5f6;
    }
    /* Temperature cell colors */
    .outdoor-color .temp-cell {
      color: #64b5f6;
      font-weight: 600;
    }
    .ambient-color .temp-cell {
      color: #ffffff;
      font-weight: 600;
    }
    .test-probe-color .temp-cell {
      color: #ef5350;
      font-weight: 600;
    }
    .control-probe-color .temp-cell {
      color: #66bb6a;
      font-weight: 600;
    }
    .chart-container {
      background: #252525;
      padding: 20px;
      border-radius: 8px;
      margin: 30px 0;
      border: 1px solid #333;
    }
    canvas {
      max-height: 400px;
    }
    .sensor-section {
      margin: 40px 0;
      padding: 30px;
      background: #1f1f1f;
      border-radius: 12px;
      border: 1px solid #333;
    }
    .sensor-section h2 {
      margin-top: 0;
      color: #fff;
      font-size: 28px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
      background: #252525;
    }
    th {
      background: #1e3a5f;
      color: #64b5f6;
      padding: 14px;
      text-align: left;
      font-weight: 600;
      position: sticky;
      top: 0;
      border-bottom: 2px solid #64b5f6;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid #333;
      color: #d0d0d0;
    }
    tr:hover {
      background: #2a2a2a;
    }
    tr:nth-child(even) {
      background: #222;
    }
    tr:nth-child(even):hover {
      background: #2a2a2a;
    }
    .temp-cell {
      font-weight: 600;
      color: #64b5f6;
      font-size: 16px;
    }
    .toc {
      position: fixed;
      left: 0;
      top: 0;
      width: 280px;
      height: 100vh;
      background: #1f1f1f;
      padding: 30px 20px;
      border-right: 2px solid #333;
      overflow-y: auto;
      z-index: 1000;
    }
    .toc h2 {
      margin-top: 0;
      color: #64b5f6;
      font-size: 20px;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 2px solid #333;
    }
    .toc ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .toc li {
      margin: 8px 0;
    }
    .toc a {
      color: #b0b0b0;
      text-decoration: none;
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      transition: all 0.2s;
      border-left: 3px solid transparent;
    }
    .toc a:hover {
      background: #2a2a2a;
      color: #64b5f6;
      border-left-color: #64b5f6;
      padding-left: 15px;
    }
    html {
      scroll-behavior: smooth;
    }
    @media print {
      body {
        background: white;
        color: black;
        display: block;
      }
      .container {
        margin-left: 0;
        padding: 20px;
      }
      .toc {
        display: none;
      }
    }
    .collapsible-header {
      background: #2a2a2a;
      padding: 12px 20px;
      cursor: pointer;
      border-radius: 8px;
      margin: 20px 0 10px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border: 1px solid #333;
      transition: background 0.2s;
    }
    .collapsible-header:hover {
      background: #333;
    }
    .collapsible-header h3 {
      margin: 0;
      color: #64b5f6;
      font-size: 18px;
    }
    .collapsible-arrow {
      font-size: 20px;
      transition: transform 0.3s;
    }
    .collapsible-arrow.expanded {
      transform: rotate(180deg);
    }
    .collapsible-content {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease-out;
    }
    .collapsible-content.expanded {
      max-height: 100000px;
      transition: max-height 0.5s ease-in;
    }
  </style>
</head>
<body>
  <!-- Table of Contents Sidebar -->
  <div class="toc">
    <h2>📋 Table of Contents</h2>
    <ul>
      ${sampledOutdoorReadings.length > 0 ? `
      <li><a href="#outdoor-section">🌤️ Outdoor Weather Temperature</a></li>
      ` : ''}
      ${ambientReadings.length > 0 ? `
      <li><a href="#ambient-section">🌡️ Ambient Temperature</a></li>
      ` : ''}
      ${testProbeReadings.length > 0 ? `
      <li><a href="#test-probe-section">🎯 Test Probe Temperature</a></li>
      ` : ''}
      ${controlProbeReadings.length > 0 ? `
      <li><a href="#control-probe-section">🔬 Control Probe Temperature</a></li>
      ` : ''}
    </ul>
  </div>

  <div class="container">
    <h1>🌡️ Temperature Readings Report</h1>

    <div class="metadata">
      <p><strong>Device:</strong> ${DEVICE_ID}</p>
      <p><strong>Time Range</strong></p>
      <p style="margin-left: 20px;"><strong>Start Date:</strong> ${formatChicagoDate(trackingStartTime)}</p>
      <p style="margin-left: 20px;"><strong>Start Time:</strong> ${formatChicagoTime(trackingStartTime)}</p>
      <p style="margin-left: 20px;"><strong>End Date:</strong> ${formatChicagoDate(trackingEndTime)}</p>
      <p style="margin-left: 20px;"><strong>End Time:</strong> ${formatChicagoTime(trackingEndTime)}</p>
      <p><strong>Time Zone:</strong> ${TIME_ZONE}</p>
      <p><strong>Total Readings Collected:</strong> ${sortedReadings.length}</p>
      <p><strong>Sampled Readings in Report:</strong> ${reportReadings.length}</p>
      <p><strong>Sampling Interval:</strong> ${samplingInterval} ${samplingIntervalUnit} (${samplingIntervalInSeconds}s)</p>
      <p><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { timeZone: TIME_ZONE })}</p>
      <p><strong>Report Version:</strong> ${APP_VERSION}</p>
    </div>

    <!-- Temperature Unit Toggle -->
    <div style="margin: 20px 0; padding: 15px; background: #252525; border-radius: 8px; border: 1px solid #333;">
      <div style="display: flex; align-items: center; gap: 15px; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 15px;">
          <span style="font-weight: 600; color: #e0e0e0;">Chart Temperature Unit:</span>
          <button id="toggleCelsius" onclick="switchToUnit('celsius')" style="padding: 8px 16px; border-radius: 6px; border: 2px solid #64b5f6; background: #64b5f6; color: white; font-weight: 600; cursor: pointer;">
            Celsius (°C)
          </button>
          <button id="toggleFahrenheit" onclick="switchToUnit('fahrenheit')" style="padding: 8px 16px; border-radius: 6px; border: 2px solid #444; background: transparent; color: #b0b0b0; font-weight: 600; cursor: pointer;">
            Fahrenheit (°F)
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: 15px; margin-left: auto;">
          <span style="font-weight: 600; color: #e0e0e0;">Data Tables:</span>
          <button id="toggleExpandAll" onclick="toggleAllTables()" style="padding: 8px 16px; border-radius: 6px; border: 2px solid #66bb6a; background: transparent; color: #b0b0b0; font-weight: 600; cursor: pointer;">
            Expand All
          </button>
        </div>
      </div>
    </div>

    <!-- Outdoor Weather Section -->
    ${sampledOutdoorReadings.length > 0 ? `
    <div class="sensor-section outdoor-color" id="outdoor-section">
      <h2>🌤️ Outdoor Weather Temperature (ZIP 53224)</h2>

      <div class="summary">
        <div class="summary-card">
          <h3>Statistics</h3>
          <p><strong>Readings:</strong> ${stats['outdoor']?.count || 0}</p>
          <p><strong>Min:</strong> ${stats['outdoor']?.min.toFixed(2) || 0} °C (${((stats['outdoor']?.min || 0) * 9/5 + 32).toFixed(2)} °F)</p>
          <p><strong>Max:</strong> ${stats['outdoor']?.max.toFixed(2) || 0} °C (${((stats['outdoor']?.max || 0) * 9/5 + 32).toFixed(2)} °F)</p>
          <p><strong>Avg:</strong> ${stats['outdoor']?.avg.toFixed(2) || 0} °C (${((stats['outdoor']?.avg || 0) * 9/5 + 32).toFixed(2)} °F)</p>
          <p style="font-size: 13px; opacity: 0.75; margin-top: 10px;"><em>Source: Open-Meteo API (Milwaukee, WI)</em></p>
        </div>
      </div>

      <div class="chart-container">
        <canvas id="outdoorChart"></canvas>
      </div>

      <div class="collapsible-header" onclick="toggleTable(this)">
        <h3>📊 Timestamp Data (${sampledOutdoorReadings.length} readings)</h3>
        <span class="collapsible-arrow">▼</span>
      </div>
      <div class="collapsible-content">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Temperature (°C)</th>
              <th>Temperature (°F)</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            ${sampledOutdoorReadings.map(reading => `
            <tr>
              <td>${formatChicago(reading.ts_utc)}</td>
              <td class="temp-cell">${Number(reading.temp_c).toFixed(2)} °C</td>
              <td class="temp-cell">${(Number(reading.temp_c) * 9/5 + 32).toFixed(2)} °F</td>
              <td>Open-Meteo API</td>
            </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- Ambient Sensor Section -->
    ${ambientReadings.length > 0 ? `
    <div class="sensor-section ambient-color" id="ambient-section">
      <h2>🌡️ Ambient Temperature</h2>

      <div class="summary">
        <div class="summary-card">
          <h3>Statistics</h3>
          <p><strong>Readings:</strong> ${stats['ambient']?.count || 0}</p>
          <p><strong>Min:</strong> ${stats['ambient']?.min.toFixed(2) || 0} °C (${((stats['ambient']?.min || 0) * 9/5 + 32).toFixed(2)} °F)</p>
          <p><strong>Max:</strong> ${stats['ambient']?.max.toFixed(2) || 0} °C (${((stats['ambient']?.max || 0) * 9/5 + 32).toFixed(2)} °F)</p>
          <p><strong>Avg:</strong> ${stats['ambient']?.avg.toFixed(2) || 0} °C (${((stats['ambient']?.avg || 0) * 9/5 + 32).toFixed(2)} °F)</p>
        </div>
      </div>

      <div class="chart-container">
        <canvas id="ambientChart"></canvas>
      </div>

      <div class="collapsible-header" onclick="toggleTable(this)">
        <h3>📊 Timestamp Data (${ambientReadings.length} readings)</h3>
        <span class="collapsible-arrow">▼</span>
      </div>
      <div class="collapsible-content">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Temperature (°C)</th>
              <th>Temperature (°F)</th>
              <th>Sensor ID</th>
            </tr>
          </thead>
          <tbody>
            ${ambientReadings.map(reading => `
            <tr>
              <td>${formatChicago(reading.ts_utc)}</td>
              <td class="temp-cell">${Number(reading.temp_c).toFixed(2)} °C</td>
              <td class="temp-cell">${(Number(reading.temp_c) * 9/5 + 32).toFixed(2)} °F</td>
              <td>${reading.sensor_id}</td>
            </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- Test Probe Sensor Section -->
    ${testProbeReadings.length > 0 ? `
    <div class="sensor-section test-probe-color" id="test-probe-section">
      <h2>🎯 Test Probe Temperature</h2>

      <div class="summary">
        <div class="summary-card">
          <h3>Statistics</h3>
          <p><strong>Readings:</strong> ${stats['test_probe']?.count || 0}</p>
          <p><strong>Min:</strong> ${stats['test_probe']?.min.toFixed(2) || 0} °C (${((stats['test_probe']?.min || 0) * 9/5 + 32).toFixed(2)} °F)</p>
          <p><strong>Max:</strong> ${stats['test_probe']?.max.toFixed(2) || 0} °C (${((stats['test_probe']?.max || 0) * 9/5 + 32).toFixed(2)} °F)</p>
          <p><strong>Avg:</strong> ${stats['test_probe']?.avg.toFixed(2) || 0} °C (${((stats['test_probe']?.avg || 0) * 9/5 + 32).toFixed(2)} °F)</p>
        </div>
      </div>

      <div class="chart-container">
        <canvas id="testProbeChart"></canvas>
      </div>

      <div class="collapsible-header" onclick="toggleTable(this)">
        <h3>📊 Timestamp Data (${testProbeReadings.length} readings)</h3>
        <span class="collapsible-arrow">▼</span>
      </div>
      <div class="collapsible-content">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Temperature (°C)</th>
              <th>Temperature (°F)</th>
              <th>Sensor ID</th>
            </tr>
          </thead>
          <tbody>
            ${testProbeReadings.map((reading: Reading) => `
            <tr>
              <td>${formatChicago(reading.ts_utc)}</td>
              <td class="temp-cell">${Number(reading.temp_c).toFixed(2)} °C</td>
              <td class="temp-cell">${(Number(reading.temp_c) * 9/5 + 32).toFixed(2)} °F</td>
              <td>${reading.sensor_id}</td>
            </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- Control Probe Sensor Section -->
    ${controlProbeReadings.length > 0 ? `
    <div class="sensor-section control-probe-color" id="control-probe-section">
      <h2>🔬 Control Probe Temperature</h2>

      <div class="summary">
        <div class="summary-card">
          <h3>Statistics</h3>
          <p><strong>Readings:</strong> ${stats['control_probe']?.count || 0}</p>
          <p><strong>Min:</strong> ${stats['control_probe']?.min.toFixed(2) || 0} °C (${((stats['control_probe']?.min || 0) * 9/5 + 32).toFixed(2)} °F)</p>
          <p><strong>Max:</strong> ${stats['control_probe']?.max.toFixed(2) || 0} °C (${((stats['control_probe']?.max || 0) * 9/5 + 32).toFixed(2)} °F)</p>
          <p><strong>Avg:</strong> ${stats['control_probe']?.avg.toFixed(2) || 0} °C (${((stats['control_probe']?.avg || 0) * 9/5 + 32).toFixed(2)} °F)</p>
        </div>
      </div>

      <div class="chart-container">
        <canvas id="controlProbeChart"></canvas>
      </div>

      <div class="collapsible-header" onclick="toggleTable(this)">
        <h3>📊 Timestamp Data (${controlProbeReadings.length} readings)</h3>
        <span class="collapsible-arrow">▼</span>
      </div>
      <div class="collapsible-content">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Temperature (°C)</th>
              <th>Temperature (°F)</th>
              <th>Sensor ID</th>
            </tr>
          </thead>
          <tbody>
            ${controlProbeReadings.map((reading: Reading) => `
            <tr>
              <td>${formatChicago(reading.ts_utc)}</td>
              <td class="temp-cell">${Number(reading.temp_c).toFixed(2)} °C</td>
              <td class="temp-cell">${(Number(reading.temp_c) * 9/5 + 32).toFixed(2)} °F</td>
              <td>${reading.sensor_id}</td>
            </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}
  </div>

  <script>
    // Chart.js default colors for dark theme
    Chart.defaults.color = '#e0e0e0';
    Chart.defaults.borderColor = '#333';

    // Store chart instances
    let outdoorChart = null;
    let ambientChart = null;
    let testProbeChart = null;
    let controlProbeChart = null;
    let currentUnit = 'celsius';

    // Temperature data (Celsius and Fahrenheit)
    const chartData = {
      outdoor: {
        labels: ${JSON.stringify(outdoorLabels)},
        celsius: ${JSON.stringify(outdoorTempsC)},
        fahrenheit: ${JSON.stringify(outdoorTempsF)}
      },
      ambient: {
        labels: ${JSON.stringify(ambientLabels)},
        celsius: ${JSON.stringify(ambientTempsC)},
        fahrenheit: ${JSON.stringify(ambientTempsF)}
      },
      testProbe: {
        labels: ${JSON.stringify(testProbeLabels)},
        celsius: ${JSON.stringify(testProbeTempsC)},
        fahrenheit: ${JSON.stringify(testProbeTempsF)}
      },
      controlProbe: {
        labels: ${JSON.stringify(controlProbeLabels)},
        celsius: ${JSON.stringify(controlProbeTempsC)},
        fahrenheit: ${JSON.stringify(controlProbeTempsF)}
      }
    };

    // Function to toggle individual table
    function toggleTable(header) {
      const content = header.nextElementSibling;
      const arrow = header.querySelector('.collapsible-arrow');

      if (content.classList.contains('expanded')) {
        content.classList.remove('expanded');
        arrow.classList.remove('expanded');
      } else {
        content.classList.add('expanded');
        arrow.classList.add('expanded');
      }
    }

    // Function to toggle all tables
    function toggleAllTables() {
      const headers = document.querySelectorAll('.collapsible-header');
      const contents = document.querySelectorAll('.collapsible-content');
      const arrows = document.querySelectorAll('.collapsible-arrow');
      const button = document.getElementById('toggleExpandAll');

      // Check if any are collapsed
      const anyCollapsed = Array.from(contents).some(c => !c.classList.contains('expanded'));

      if (anyCollapsed) {
        // Expand all
        contents.forEach(c => c.classList.add('expanded'));
        arrows.forEach(a => a.classList.add('expanded'));
        button.textContent = 'Collapse All';
        button.style.background = '#66bb6a';
        button.style.borderColor = '#66bb6a';
        button.style.color = 'white';
      } else {
        // Collapse all
        contents.forEach(c => c.classList.remove('expanded'));
        arrows.forEach(a => a.classList.remove('expanded'));
        button.textContent = 'Expand All';
        button.style.background = 'transparent';
        button.style.borderColor = '#66bb6a';
        button.style.color = '#b0b0b0';
      }
    }

    // Function to switch temperature unit
    function switchToUnit(unit) {
      currentUnit = unit;

      // Update button styles
      const celsiusBtn = document.getElementById('toggleCelsius');
      const fahrenheitBtn = document.getElementById('toggleFahrenheit');

      if (unit === 'celsius') {
        celsiusBtn.style.background = '#64b5f6';
        celsiusBtn.style.borderColor = '#64b5f6';
        celsiusBtn.style.color = 'white';
        fahrenheitBtn.style.background = 'transparent';
        fahrenheitBtn.style.borderColor = '#444';
        fahrenheitBtn.style.color = '#b0b0b0';
      } else {
        fahrenheitBtn.style.background = '#64b5f6';
        fahrenheitBtn.style.borderColor = '#64b5f6';
        fahrenheitBtn.style.color = 'white';
        celsiusBtn.style.background = 'transparent';
        celsiusBtn.style.borderColor = '#444';
        celsiusBtn.style.color = '#b0b0b0';
      }

      // Update charts
      if (outdoorChart) {
        outdoorChart.data.datasets[0].data = unit === 'celsius' ? chartData.outdoor.celsius : chartData.outdoor.fahrenheit;
        outdoorChart.data.datasets[0].label = unit === 'celsius' ? 'Outdoor Temperature (°C)' : 'Outdoor Temperature (°F)';
        outdoorChart.options.scales.y.title.text = unit === 'celsius' ? 'Temperature (°C)' : 'Temperature (°F)';
        outdoorChart.update();
      }

      if (ambientChart) {
        ambientChart.data.datasets[0].data = unit === 'celsius' ? chartData.ambient.celsius : chartData.ambient.fahrenheit;
        ambientChart.data.datasets[0].label = unit === 'celsius' ? 'Ambient Temperature (°C)' : 'Ambient Temperature (°F)';
        ambientChart.options.scales.y.title.text = unit === 'celsius' ? 'Temperature (°C)' : 'Temperature (°F)';
        ambientChart.update();
      }

      if (testProbeChart) {
        testProbeChart.data.datasets[0].data = unit === 'celsius' ? chartData.testProbe.celsius : chartData.testProbe.fahrenheit;
        testProbeChart.data.datasets[0].label = unit === 'celsius' ? 'Test Probe Temperature (°C)' : 'Test Probe Temperature (°F)';
        testProbeChart.options.scales.y.title.text = unit === 'celsius' ? 'Temperature (°C)' : 'Temperature (°F)';
        testProbeChart.update();
      }

      if (controlProbeChart) {
        controlProbeChart.data.datasets[0].data = unit === 'celsius' ? chartData.controlProbe.celsius : chartData.controlProbe.fahrenheit;
        controlProbeChart.data.datasets[0].label = unit === 'celsius' ? 'Control Probe Temperature (°C)' : 'Control Probe Temperature (°F)';
        controlProbeChart.options.scales.y.title.text = unit === 'celsius' ? 'Temperature (°C)' : 'Temperature (°F)';
        controlProbeChart.update();
      }
    }

    // Outdoor Weather Chart
    ${sampledOutdoorReadings.length > 0 ? `
    const outdoorCtx = document.getElementById('outdoorChart').getContext('2d');
    outdoorChart = new Chart(outdoorCtx, {
      type: 'line',
      data: {
        labels: chartData.outdoor.labels,
        datasets: [{
          label: 'Outdoor Temperature (°C)',
          data: chartData.outdoor.celsius,
          borderColor: '#64b5f6',
          backgroundColor: 'rgba(100, 181, 246, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#64b5f6',
          pointBorderColor: '#1f1f1f',
          pointBorderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#e0e0e0',
              font: { size: 14 }
            }
          },
          tooltip: {
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: '#ffffff',
            bodyColor: '#e0e0e0',
            borderColor: '#64b5f6',
            borderWidth: 1
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#b0b0b0',
              maxRotation: 45,
              minRotation: 45
            },
            grid: {
              color: '#333'
            }
          },
          y: {
            ticks: {
              color: '#b0b0b0'
            },
            grid: {
              color: '#333'
            },
            title: {
              display: true,
              text: 'Temperature (°C)',
              color: '#64b5f6'
            }
          }
        }
      }
    });
    ` : ''}

    // Ambient Chart
    ${ambientReadings.length > 0 ? `
    const ambientCtx = document.getElementById('ambientChart').getContext('2d');
    ambientChart = new Chart(ambientCtx, {
      type: 'line',
      data: {
        labels: chartData.ambient.labels,
        datasets: [{
          label: 'Ambient Temperature (°C)',
          data: chartData.ambient.celsius,
          borderColor: '#ffffff',
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#1f1f1f',
          pointBorderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#e0e0e0',
              font: { size: 14 }
            }
          },
          tooltip: {
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: '#ffffff',
            bodyColor: '#e0e0e0',
            borderColor: '#ffffff',
            borderWidth: 1
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#b0b0b0',
              maxRotation: 45,
              minRotation: 45
            },
            grid: {
              color: '#333'
            }
          },
          y: {
            ticks: {
              color: '#b0b0b0'
            },
            grid: {
              color: '#333'
            },
            title: {
              display: true,
              text: 'Temperature (°C)',
              color: '#ffffff'
            }
          }
        }
      }
    });
    ` : ''}

    // Test Probe Chart
    ${testProbeReadings.length > 0 ? `
    const testProbeCtx = document.getElementById('testProbeChart').getContext('2d');
    testProbeChart = new Chart(testProbeCtx, {
      type: 'line',
      data: {
        labels: chartData.testProbe.labels,
        datasets: [{
          label: 'Test Probe Temperature (°C)',
          data: chartData.testProbe.celsius,
          borderColor: '#ef5350',
          backgroundColor: 'rgba(239, 83, 80, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#ef5350',
          pointBorderColor: '#1f1f1f',
          pointBorderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#e0e0e0',
              font: { size: 14 }
            }
          },
          tooltip: {
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: '#ef5350',
            bodyColor: '#e0e0e0',
            borderColor: '#ef5350',
            borderWidth: 1
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#b0b0b0',
              maxRotation: 45,
              minRotation: 45
            },
            grid: {
              color: '#333'
            }
          },
          y: {
            ticks: {
              color: '#b0b0b0'
            },
            grid: {
              color: '#333'
            },
            title: {
              display: true,
              text: 'Temperature (°C)',
              color: '#ef5350'
            }
          }
        }
      }
    });
    ` : ''}

    // Control Probe Chart
    ${controlProbeReadings.length > 0 ? `
    const controlProbeCtx = document.getElementById('controlProbeChart').getContext('2d');
    controlProbeChart = new Chart(controlProbeCtx, {
      type: 'line',
      data: {
        labels: chartData.controlProbe.labels,
        datasets: [{
          label: 'Control Probe Temperature (°C)',
          data: chartData.controlProbe.celsius,
          borderColor: '#66bb6a',
          backgroundColor: 'rgba(102, 187, 106, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#66bb6a',
          pointBorderColor: '#1f1f1f',
          pointBorderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#e0e0e0',
              font: { size: 14 }
            }
          },
          tooltip: {
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: '#66bb6a',
            bodyColor: '#e0e0e0',
            borderColor: '#66bb6a',
            borderWidth: 1
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#b0b0b0',
              maxRotation: 45,
              minRotation: 45
            },
            grid: {
              color: '#333'
            }
          },
          y: {
            ticks: {
              color: '#b0b0b0'
            },
            grid: {
              color: '#333'
            },
            title: {
              display: true,
              text: 'Temperature (°C)',
              color: '#66bb6a'
            }
          }
        }
      }
    });
    ` : ''}
  </script>
</body>
</html>`;

    // If auto-send is enabled and email is provided, send email
    if (autoSend && autoEmailEnabled && emailAddress) {
      sendEmailReport(html, stats);
    }

    // Create download link
    const blob = new Blob([html], { type: "text/html;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    link.setAttribute("href", url);
    link.setAttribute("download", `temperature-readings-${Date.now()}.html`);
    link.style.visibility = "hidden";

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

useEffect(() => {
  let channel: any = null;
  let pollTimer: any = null;

  const subscribe = () => {
    // Clean up old channel if any
    if (channel) supabase.removeChannel(channel);

    console.log("🔌 Setting up Supabase realtime subscription...");

    channel = supabase
      .channel("temps-live")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "temperature_readings",
          filter: `device_id=eq.${DEVICE_ID}`,
        },
        (payload) => {
          console.log("📡 New reading received:", payload.new);
          const r = payload.new as Reading;

          // Update latest readings for live view
          setLatestBySensor((prev) => {
            const current = prev[r.sensor_name];
            if (current && new Date(current.ts_utc) >= new Date(r.ts_utc)) return prev;
            return { ...prev, [r.sensor_name]: r };
          });

          // If tracking is active and reading is within range, add it to filtered readings
          setFilteredReadings((prev) => {
            const tracking = isTrackingRef.current;
            const startTime = trackingStartTimeRef.current;
            const endTime = trackingEndTimeRef.current;

            console.log("Tracking check:", { tracking, startTime, endTime });

            if (!tracking || !startTime || !endTime) {
              return prev;
            }

            const readingTime = new Date(r.ts_utc);
            const startDateTime = new Date(startTime);
            const endDateTime = new Date(endTime);

            console.log("Time range check:", {
              readingTime: readingTime.toISOString(),
              startDateTime: startDateTime.toISOString(),
              endDateTime: endDateTime.toISOString(),
              inRange: readingTime >= startDateTime && readingTime <= endDateTime
            });

            if (readingTime >= startDateTime && readingTime <= endDateTime) {
              console.log("✅ Adding reading to tracked data:", r.sensor_name, r.temp_c);
              return [r, ...prev];
            }
            return prev;
          });
        }
      )
      .subscribe((s) => {
        console.log("📊 Subscription status:", s);
        setStatus(String(s));
      });
  };

  const refresh = async () => {
    // Pull latest values (works even if websockets are paused)
    await loadInitial();

    // Also check for new readings to add to tracking
    if (isTrackingRef.current && trackingStartTimeRef.current && trackingEndTimeRef.current) {
      const { data, error } = await supabase
        .from("temperature_readings")
        .select("device_id,sensor_id,sensor_name,temp_c,ts_utc")
        .eq("device_id", DEVICE_ID)
        .gte("ts_utc", trackingStartTimeRef.current)
        .lte("ts_utc", trackingEndTimeRef.current)
        .order("ts_utc", { ascending: false })
        .limit(100000);

      if (!error && data) {
        setFilteredReadings(data as Reading[]);
        console.log(`📊 Polling update: ${data.length} readings in tracked range`);
      }
    }
  };

  const handleResume = () => {
    // When phone returns to foreground / regains network:
    if (document.visibilityState !== "visible") return;
    setStatus("Reconnecting…");
    refresh();
    subscribe();
  };

  // Initial load + subscribe
  refresh();
  subscribe();

  // Auto-reconnect triggers
  document.addEventListener("visibilitychange", handleResume);
  window.addEventListener("focus", handleResume);
  window.addEventListener("online", handleResume);

  // Polling fallback
  // This ensures temps still update even if realtime drops silently.
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, uploadIntervalInSeconds * 1000);

  // Cleanup
  return () => {
    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("online", handleResume);

    if (pollTimer) clearInterval(pollTimer);
    if (channel) supabase.removeChannel(channel);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// --- Update "last seen" age every second ---
useEffect(() => {
  const t = setInterval(() => {
    if (!lastTsUtc) {
      setAgeSec(null);
      return;
    }

    const sec = Math.floor(
      (Date.now() - new Date(lastTsUtc).getTime()) / 1000
    );
    setAgeSec(sec);
  }, 1000);

  return () => clearInterval(t);
}, [lastTsUtc]);

// --- Auto-stop tracking when end time is reached ---
useEffect(() => {
  if (!isTracking || !trackingEndTime || trackingCompleted) return;

  const checkInterval = setInterval(() => {
    const now = new Date();
    const endTime = new Date(trackingEndTime);

    if (now >= endTime) {
      setIsTracking(false);
      setTrackingCompleted(true);
      clearInterval(checkInterval);

      // Auto-send email if enabled
      if (autoEmailEnabled && emailAddress && filteredReadings.length > 0) {
        exportToHTML(true);
      }
    }
  }, 1000); // Check every second

  return () => clearInterval(checkInterval);
}, [isTracking, trackingEndTime, trackingCompleted, autoEmailEnabled, emailAddress, filteredReadings]);

// --- Fetch outdoor weather periodically ---
useEffect(() => {
  // Fetch immediately on mount
  fetchOutdoorWeather();

  // Then fetch every 10 minutes (600000 ms)
  const weatherInterval = setInterval(fetchOutdoorWeather, 600000);

  return () => clearInterval(weatherInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// --- Auto-save CSV every 30 seconds during tracking ---
useEffect(() => {
  if (!isTracking || filteredReadings.length === 0) return;

  const saveInterval = setInterval(() => {
    if (filteredReadings.length > 0) {
      // Create CSV content
      const header = "Timestamp,Sensor Name,Sensor ID,Temperature (°C),Device ID\n";
      const rows = filteredReadings
        .sort((a, b) => new Date(a.ts_utc).getTime() - new Date(b.ts_utc).getTime())
        .map((reading) => {
          return `${formatChicago(reading.ts_utc)},${reading.sensor_name},${reading.sensor_id},${reading.temp_c},${reading.device_id}`;
        })
        .join("\n");
      const csv = header + rows;

      // Save to localStorage as backup
      localStorage.setItem('temperature_tracking_backup', csv);
      const saveTime = new Date().toLocaleTimeString();
      setLastSaveTime(saveTime);
      console.log(`Auto-saved ${filteredReadings.length} readings to backup at ${saveTime}`);
    }
  }, 30000); // Every 30 seconds

  return () => clearInterval(saveInterval);
}, [isTracking, filteredReadings]);

return (
  <main
    style={{
      padding: 16,
      maxWidth: 720,
      margin: "0 auto",
      fontFamily: "system-ui",
    }}
  >
    <h1 style={{ fontSize: 28, marginBottom: 4 }}>Live Temperatures</h1>

    <div style={{ opacity: 0.75, marginBottom: 12 }}>
      Device: <b>{DEVICE_ID}</b> • Time zone: <b>{TIME_ZONE}</b> • Status:{" "}
      <b>{status}</b> • Version: <b>{APP_VERSION}</b>
    </div>

    {/* Time Range Tracking Controls */}
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        border: "1px solid rgba(0,0,0,0.2)",
        marginBottom: 16,
        backgroundColor: "rgba(0,0,0,0.02)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          Time Range Tracking
        </div>

        {/* Toggle for Manual/Automatic Mode */}
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <span style={{ fontSize: 13, opacity: 0.75 }}>
            {useManualTime ? "Manual Time" : "Auto Start"}
          </span>
          <input
            type="checkbox"
            checked={!useManualTime}
            onChange={(e) => setUseManualTime(!e.target.checked)}
            disabled={isTracking}
            style={{ cursor: "pointer" }}
          />
        </label>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {useManualTime && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ display: "grid", gap: 8 }}>
              <label style={{ fontSize: 13, opacity: 0.75, fontWeight: 600 }}>
                Start Date & Time
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 8 }}>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={isTracking}
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.2)",
                    fontSize: 14,
                  }}
                />
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  disabled={isTracking}
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.2)",
                    fontSize: 14,
                  }}
                />
              </div>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              <label style={{ fontSize: 13, opacity: 0.75, fontWeight: 600 }}>
                End Date & Time
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 8 }}>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={isTracking}
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.2)",
                    fontSize: 14,
                  }}
                />
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  disabled={isTracking}
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.2)",
                    fontSize: 14,
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Sampling Interval Configuration */}
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <label style={{ fontSize: 13, opacity: 0.75, display: "block", marginBottom: 4 }}>
            Report Sampling Interval (filter readings to include in reports)
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number"
              min={samplingIntervalUnit === "seconds" ? "3" : "1"}
              value={samplingInterval}
              onChange={(e) => {
                const value = parseInt(e.target.value) || 1;
                const minValue = samplingIntervalUnit === "seconds" ? 3 : 1;
                setSamplingInterval(Math.max(minValue, value));
              }}
              disabled={isTracking}
              style={{
                width: 80,
                padding: 8,
                borderRadius: 8,
                border: "1px solid rgba(0,0,0,0.2)",
                fontSize: 14,
              }}
            />
            <select
              value={samplingIntervalUnit}
              onChange={(e) => {
                const newUnit = e.target.value as "seconds" | "minutes" | "hours";
                setSamplingIntervalUnit(newUnit);
                // Enforce minimum when switching to seconds
                if (newUnit === "seconds" && samplingInterval < 3) {
                  setSamplingInterval(3);
                }
              }}
              disabled={isTracking}
              style={{
                padding: 8,
                borderRadius: 8,
                border: "1px solid rgba(0,0,0,0.2)",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              <option value="seconds">Seconds</option>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
            </select>
            <span style={{ fontSize: 12, opacity: 0.5 }}>
              (Sample every {samplingIntervalInSeconds}s)
            </span>
          </div>
        </div>

        {/* Email Configuration */}
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <div>
            <label style={{ fontSize: 13, opacity: 0.75, display: "block", marginBottom: 4 }}>
              Email Address (Optional - for auto-send on completion)
            </label>
            <input
              type="email"
              value={emailAddress}
              onChange={(e) => setEmailAddress(e.target.value)}
              placeholder="your@email.com"
              disabled={isTracking}
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 8,
                border: "1px solid rgba(0,0,0,0.2)",
                fontSize: 14,
              }}
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={autoEmailEnabled}
              onChange={(e) => setAutoEmailEnabled(e.target.checked)}
              disabled={isTracking || !emailAddress}
              style={{ cursor: "pointer" }}
            />
            <span style={{ opacity: 0.75 }}>
              Automatically email report when tracking completes
            </span>
          </label>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          {!isTracking && !trackingCompleted ? (
            <button
              onClick={startTracking}
              style={{
                flex: 1,
                padding: 10,
                borderRadius: 8,
                border: "none",
                backgroundColor: "#0070f3",
                color: "white",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Start Tracking
            </button>
          ) : trackingCompleted ? (
            <>
              <button
                onClick={() => exportToHTML(false)}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 8,
                  border: "none",
                  backgroundColor: "#2196f3",
                  color: "white",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Download HTML Report
              </button>
              <button
                onClick={clearTracking}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 8,
                  border: "none",
                  backgroundColor: "#4caf50",
                  color: "white",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Clear Results
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => exportToHTML(false)}
                disabled={filteredReadings.length === 0}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 8,
                  border: "none",
                  backgroundColor: filteredReadings.length === 0 ? "#ccc" : "#2196f3",
                  color: "white",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: filteredReadings.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                Download HTML Report
              </button>
              <button
                onClick={stopTracking}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 8,
                  border: "none",
                  backgroundColor: "#d32f2f",
                  color: "white",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Stop Tracking
              </button>
            </>
          )}
        </div>

        {isTracking && !trackingCompleted && (
          <div>
            <div style={{ fontSize: 13, opacity: 0.75 }}>
              📊 Tracking active: {filteredReadings.length} readings collected
            </div>
            {lastSaveTime && (
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
                💾 Last auto-save: {lastSaveTime}
              </div>
            )}
            <div style={{ fontSize: 11, opacity: 0.5, marginTop: 8, fontFamily: "monospace", backgroundColor: "rgba(0,0,0,0.05)", padding: 8, borderRadius: 4 }}>
              Debug: tracking={String(isTracking)} | start={trackingStartTime.substring(0, 19)} | end={trackingEndTime.substring(0, 19)}
            </div>
          </div>
        )}

        {trackingCompleted && (
          <div>
            <div style={{ fontSize: 13, color: "#4caf50", fontWeight: 600 }}>
              ✅ Tracking completed! {filteredReadings.length} readings collected
            </div>
            {filteredReadings.length > 1000 && (
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4, color: "#ff9800" }}>
                ⚠️ Large dataset - email may fail on mobile. Consider increasing sampling interval.
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    {/* Database Cleanup Section */}
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        border: "1px solid rgba(0,0,0,0.2)",
        marginBottom: 16,
        backgroundColor: "rgba(0,0,0,0.02)",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
        🗄️ Database Management
      </div>

      {dbStats ? (
        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            <strong>Total Readings:</strong> {dbStats.totalCount.toLocaleString()}
          </div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            <strong>Last 7 Days:</strong> {dbStats.last7Days.toLocaleString()}
          </div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            <strong>Last 30 Days:</strong> {dbStats.last30Days.toLocaleString()}
          </div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            <strong>Older than 30 Days:</strong> {dbStats.olderThan30Days.toLocaleString()}
          </div>
          {dbStats.oldestReading && (
            <div style={{ fontSize: 13, opacity: 0.85 }}>
              <strong>Oldest Reading:</strong> {formatChicago(dbStats.oldestReading)}
            </div>
          )}
          {dbStats.newestReading && (
            <div style={{ fontSize: 13, opacity: 0.85 }}>
              <strong>Newest Reading:</strong> {formatChicago(dbStats.newestReading)}
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 12 }}>
          Click "Refresh Stats" to view database statistics
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={fetchDbStats}
          disabled={cleanupInProgress}
          style={{
            flex: 1,
            padding: 10,
            borderRadius: 8,
            border: "none",
            backgroundColor: cleanupInProgress ? "#ccc" : "#2196f3",
            color: "white",
            fontSize: 14,
            fontWeight: 600,
            cursor: cleanupInProgress ? "not-allowed" : "pointer",
          }}
        >
          {cleanupInProgress ? "Processing..." : "Refresh Stats"}
        </button>
        <button
          onClick={cleanupOldReadings}
          disabled={cleanupInProgress || !dbStats || dbStats.totalCount === 0}
          style={{
            flex: 1,
            padding: 10,
            borderRadius: 8,
            border: "none",
            backgroundColor: cleanupInProgress || !dbStats || dbStats.totalCount === 0 ? "#ccc" : "#ff9800",
            color: "white",
            fontSize: 14,
            fontWeight: 600,
            cursor: cleanupInProgress || !dbStats || dbStats.totalCount === 0 ? "not-allowed" : "pointer",
          }}
        >
          {cleanupInProgress ? "Cleaning..." : "Cleanup Old Data"}
        </button>
      </div>

      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>
        Cleanup removes old readings to save database space. This action cannot be undone.
      </div>
    </div>

    {/* 🔽 ADDED: Offline / Live indicator banner */}
    {ageSec !== null && (
      <div
        style={{
          padding: 12,
          borderRadius: 12,
          border: "1px solid rgba(0,0,0,0.2)",
          marginBottom: 16,
        }}
      >
        {isOffline ? (
          <>
            ⚠️ <b>Device appears offline.</b> No new readings for{" "}
            <b>{ageSec}s</b>.
          </>
        ) : (
          <>
            ✅ <b>Receiving updates.</b> Last update{" "}
            <b>{ageSec}s</b> ago.
          </>
        )}

        {lastTsUtc && (
          <div style={{ marginTop: 6, opacity: 0.75, fontSize: 13 }}>
            Last reading: <b>{formatChicago(lastTsUtc)}</b>
          </div>
        )}
      </div>
    )}
    {/* 🔼 END added section */}

    {/* Outdoor Weather Temperature */}
    {outdoorTemp !== null && (
      <div
        style={{
          backgroundColor: "#1f1f1f",
          border: "1px solid rgba(0,0,0,0.15)",
          borderRadius: 16,
          padding: 16,
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700 }}>
          outdoor (ZIP 53224)
        </div>

        <div style={{ fontSize: 42, fontWeight: 800, marginTop: 6, color: getSensorColor('outdoor') }}>
          {outdoorTemp.toFixed(2)} °C
        </div>

        <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, opacity: 0.8, color: getSensorColor('outdoor') }}>
          {celsiusToFahrenheit(outdoorTemp).toFixed(2)} °F
        </div>

        {outdoorLastUpdate && (
          <div style={{ marginTop: 8, opacity: 0.75, fontSize: 14 }}>
            Updated: <b>{formatChicago(outdoorLastUpdate)}</b>
          </div>
        )}

        <div style={{ marginTop: 4, opacity: 0.6, fontSize: 12 }}>
          Source: Open-Meteo API (Milwaukee, WI)
        </div>
      </div>
    )}

    {rows.length === 0 ? (
      <p style={{ opacity: 0.7 }}>
        No data yet. Make sure your Pi uploader is running.
      </p>
    ) : (
      <div style={{ display: "grid", gap: 12 }}>
        {rows.map((r) => (
          <div
            key={r.sensor_name}
            style={{
              border: "1px solid rgba(0,0,0,0.15)",
              borderRadius: 16,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {r.sensor_name}
            </div>

            <div style={{ fontSize: 42, fontWeight: 800, marginTop: 6, color: getSensorColor(r.sensor_name) }}>
              {Number(r.temp_c).toFixed(2)} °C
            </div>

            <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, opacity: 0.8, color: getSensorColor(r.sensor_name) }}>
              {celsiusToFahrenheit(Number(r.temp_c)).toFixed(2)} °F
            </div>

            <div style={{ marginTop: 8, opacity: 0.75, fontSize: 14 }}>
              Updated: <b>{formatChicago(r.ts_utc)}</b>
            </div>

            <div style={{ marginTop: 4, opacity: 0.6, fontSize: 12 }}>
              sensor_id: {r.sensor_id}
            </div>
          </div>
        ))}
      </div>
    )}

    {/* Tracked Time Range Data */}
    {(isTracking || trackingCompleted) && filteredReadings.length > 0 && (
      <div style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 24, marginBottom: 16 }}>
          Tracked Readings
          {trackingStartTime && trackingEndTime && (
            <span style={{ fontSize: 14, fontWeight: 400, opacity: 0.75, marginLeft: 8 }}>
              ({formatChicago(trackingStartTime)} - {formatChicago(trackingEndTime)})
            </span>
          )}
        </h2>

        {Object.entries(filteredBySensor)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([sensorName, readings]) => (
            <div
              key={sensorName}
              style={{
                border: "1px solid rgba(0,0,0,0.15)",
                borderRadius: 16,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>
                {sensorName} ({readings.length} readings)
                {readings.length > 10 && (
                  <span style={{ fontSize: 14, fontWeight: 400, opacity: 0.6, marginLeft: 8 }}>
                    - showing latest 10
                  </span>
                )}
              </div>

              <div style={{ display: "grid", gap: 8 }}>
                {readings.slice(0, 10).map((reading, idx) => (
                  <div
                    key={`${reading.ts_utc}-${idx}`}
                    style={{
                      padding: 12,
                      borderRadius: 8,
                      backgroundColor: "rgba(0,0,0,0.03)",
                      display: "grid",
                      gridTemplateColumns: "auto 1fr",
                      gap: 12,
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: getSensorColor(sensorName) }}>
                        {Number(reading.temp_c).toFixed(2)} °C
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 600, opacity: 0.7, marginTop: 2, color: getSensorColor(sensorName) }}>
                        {celsiusToFahrenheit(Number(reading.temp_c)).toFixed(2)} °F
                      </div>
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.75 }}>
                      {formatChicago(reading.ts_utc)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
      </div>
    )}
  </main>
);
}
