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
const APP_VERSION = "1.2.0"; // Application version

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

export default function Home() {
  const [latestBySensor, setLatestBySensor] = useState<Record<string, Reading>>(
    {}
  );
  const [status, setStatus] = useState<string>("Connecting…");

  // --- Time range tracking ---
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [startTime, setStartTime] = useState<string>("");
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
      if (!selectedDate || !startTime || !endTime) {
        alert("Please select a date, start time, and end time");
        return;
      }

      startDateTime = new Date(`${selectedDate}T${startTime}:00`);
      endDateTime = new Date(`${selectedDate}T${endTime}:00`);

      if (endDateTime <= startDateTime) {
        alert("End time must be after start time");
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
        .order("ts_utc", { ascending: false });

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
    setTrackingStartTime("");
    setTrackingEndTime("");
    if (useManualTime) {
      setSelectedDate("");
      setStartTime("");
      setEndTime("");
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

      const response = await fetch('/api/send-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: emailAddress,
          htmlContent,
          summary,
          timeRange,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        alert(`Email sent successfully to ${emailAddress}!`);
      } else {
        const errorMsg = data.details || data.error || 'Unknown error';
        alert(`Failed to send email: ${errorMsg}`);
      }
    } catch (error) {
      console.error('Email send error:', error);
      alert(`Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

    // Group by sensor for summary stats
    const stats: Record<string, { min: number; max: number; avg: number; count: number }> = {};
    sortedReadings.forEach((r) => {
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
    const ambientReadings = reportReadings.filter(r => r.sensor_name === 'ambient_room');
    const probeReadings = reportReadings.filter(r => r.sensor_name === 'probe_target');

    // Prepare chart data for ambient_room
    const ambientLabels = ambientReadings.map(r => formatChicago(r.ts_utc));
    const ambientTemps = ambientReadings.map(r => Number(r.temp_c));

    // Prepare chart data for probe_target
    const probeLabels = probeReadings.map(r => formatChicago(r.ts_utc));
    const probeTemps = probeReadings.map(r => Number(r.temp_c));

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
  </style>
</head>
<body>
  <!-- Table of Contents Sidebar -->
  <div class="toc">
    <h2>📋 Table of Contents</h2>
    <ul>
      ${ambientReadings.length > 0 ? `
      <li><a href="#ambient-section">🌡️ Ambient Room Temperature</a></li>
      ` : ''}
      ${probeReadings.length > 0 ? `
      <li><a href="#probe-section">🎯 Probe Target Temperature</a></li>
      ` : ''}
    </ul>
  </div>

  <div class="container">
    <h1>🌡️ Temperature Readings Report</h1>

    <div class="metadata">
      <p><strong>Device:</strong> ${DEVICE_ID}</p>
      <p><strong>Time Range:</strong> ${formatChicago(trackingStartTime)} - ${formatChicago(trackingEndTime)}</p>
      <p><strong>Time Zone:</strong> ${TIME_ZONE}</p>
      <p><strong>Total Readings Collected:</strong> ${sortedReadings.length}</p>
      <p><strong>Sampled Readings in Report:</strong> ${reportReadings.length}</p>
      <p><strong>Sampling Interval:</strong> ${samplingInterval} ${samplingIntervalUnit} (${samplingIntervalInSeconds}s)</p>
      <p><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { timeZone: TIME_ZONE })}</p>
      <p><strong>Report Version:</strong> ${APP_VERSION}</p>
    </div>

    <!-- Ambient Room Sensor Section -->
    ${ambientReadings.length > 0 ? `
    <div class="sensor-section" id="ambient-section">
      <h2>🌡️ Ambient Room Temperature</h2>

      <div class="summary">
        <div class="summary-card">
          <h3>Statistics</h3>
          <p><strong>Readings:</strong> ${stats['ambient_room']?.count || 0}</p>
          <p><strong>Min:</strong> ${stats['ambient_room']?.min.toFixed(2) || 0} °C</p>
          <p><strong>Max:</strong> ${stats['ambient_room']?.max.toFixed(2) || 0} °C</p>
          <p><strong>Avg:</strong> ${stats['ambient_room']?.avg.toFixed(2) || 0} °C</p>
        </div>
      </div>

      <div class="chart-container">
        <canvas id="ambientChart"></canvas>
      </div>

      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Temperature (°C)</th>
            <th>Sensor ID</th>
          </tr>
        </thead>
        <tbody>
          ${ambientReadings.map(reading => `
          <tr>
            <td>${formatChicago(reading.ts_utc)}</td>
            <td class="temp-cell">${Number(reading.temp_c).toFixed(2)} °C</td>
            <td>${reading.sensor_id}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    <!-- Probe Target Sensor Section -->
    ${probeReadings.length > 0 ? `
    <div class="sensor-section" id="probe-section">
      <h2>🎯 Probe Target Temperature</h2>

      <div class="summary">
        <div class="summary-card">
          <h3>Statistics</h3>
          <p><strong>Readings:</strong> ${stats['probe_target']?.count || 0}</p>
          <p><strong>Min:</strong> ${stats['probe_target']?.min.toFixed(2) || 0} °C</p>
          <p><strong>Max:</strong> ${stats['probe_target']?.max.toFixed(2) || 0} °C</p>
          <p><strong>Avg:</strong> ${stats['probe_target']?.avg.toFixed(2) || 0} °C</p>
        </div>
      </div>

      <div class="chart-container">
        <canvas id="probeChart"></canvas>
      </div>

      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Temperature (°C)</th>
            <th>Sensor ID</th>
          </tr>
        </thead>
        <tbody>
          ${probeReadings.map(reading => `
          <tr>
            <td>${formatChicago(reading.ts_utc)}</td>
            <td class="temp-cell">${Number(reading.temp_c).toFixed(2)} °C</td>
            <td>${reading.sensor_id}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}
  </div>

  <script>
    // Chart.js default colors for dark theme
    Chart.defaults.color = '#e0e0e0';
    Chart.defaults.borderColor = '#333';

    // Ambient Room Chart
    ${ambientReadings.length > 0 ? `
    const ambientCtx = document.getElementById('ambientChart').getContext('2d');
    new Chart(ambientCtx, {
      type: 'line',
      data: {
        labels: ${JSON.stringify(ambientLabels)},
        datasets: [{
          label: 'Ambient Room Temperature (°C)',
          data: ${JSON.stringify(ambientTemps)},
          borderColor: '#64b5f6',
          backgroundColor: 'rgba(100, 181, 246, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#64b5f6',
          pointBorderColor: '#1e3a5f',
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
            titleColor: '#64b5f6',
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

    // Probe Target Chart
    ${probeReadings.length > 0 ? `
    const probeCtx = document.getElementById('probeChart').getContext('2d');
    new Chart(probeCtx, {
      type: 'line',
      data: {
        labels: ${JSON.stringify(probeLabels)},
        datasets: [{
          label: 'Probe Target Temperature (°C)',
          data: ${JSON.stringify(probeTemps)},
          borderColor: '#ff9800',
          backgroundColor: 'rgba(255, 152, 0, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#ff9800',
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
            titleColor: '#ff9800',
            bodyColor: '#e0e0e0',
            borderColor: '#ff9800',
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
              color: '#ff9800'
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
        .limit(100);

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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div>
              <label style={{ fontSize: 13, opacity: 0.75, display: "block", marginBottom: 4 }}>
                Date
              </label>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
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

            <div>
              <label style={{ fontSize: 13, opacity: 0.75, display: "block", marginBottom: 4 }}>
                Start Time
              </label>
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

            <div>
              <label style={{ fontSize: 13, opacity: 0.75, display: "block", marginBottom: 4 }}>
                End Time
              </label>
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
        )}

        {/* Sampling Interval Configuration */}
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <label style={{ fontSize: 13, opacity: 0.75, display: "block", marginBottom: 4 }}>
            Report Sampling Interval (filter readings to include in reports)
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number"
              min="1"
              value={samplingInterval}
              onChange={(e) => setSamplingInterval(Math.max(1, parseInt(e.target.value) || 1))}
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
              onChange={(e) => setSamplingIntervalUnit(e.target.value as "seconds" | "minutes" | "hours")}
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
          <div style={{ fontSize: 13, color: "#4caf50", fontWeight: 600 }}>
            ✅ Tracking completed! {filteredReadings.length} readings collected
          </div>
        )}
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

            <div style={{ fontSize: 42, fontWeight: 800, marginTop: 6 }}>
              {Number(r.temp_c).toFixed(2)} °C
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
              </div>

              <div style={{ display: "grid", gap: 8 }}>
                {readings.map((reading, idx) => (
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
                    <div style={{ fontSize: 24, fontWeight: 700 }}>
                      {Number(reading.temp_c).toFixed(2)} °C
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
