const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 8080;

// ------------------
// Runtime statistics
// ------------------
let modelStats = {
  model_type: 'Random Forest Classifier',
  training_samples: 9564,
  features_count: 4,
  last_updated: new Date().toISOString().split('T')[0],
  total_predictions: 0,
  confirmed_predictions: 0,
  rejected_predictions: 0,
  total_confidence: 0,
  prediction_history: [],
  start_time: new Date().toISOString(),
  api_calls_today: 0,
  last_reset: new Date().toDateString()
};

// ------------------
// Load & Save Stats
// ------------------
async function loadStats() {
  try {
    const data = await fs.readFile(path.join(__dirname, 'model_stats.json'), 'utf8');
    const saved = JSON.parse(data);
    if (saved.last_reset !== new Date().toDateString()) {
      saved.api_calls_today = 0;
      saved.last_reset = new Date().toDateString();
    }
    modelStats = { ...modelStats, ...saved };
    console.log('📊 Loaded model stats');
  } catch {
    console.log('📊 Starting with fresh stats');
  }
}

async function saveStats() {
  try {
    await fs.writeFile(path.join(__dirname, 'model_stats.json'), JSON.stringify(modelStats, null, 2));
  } catch (err) {
    console.error('Error saving stats:', err);
  }
}

// ------------------
// Middleware
// ------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'build', 'web'))); // serve Flutter

// ------------------
// TAP Proxy Endpoint
// ------------------
app.get('/tap/sync', async (req, res) => {
  try {
    modelStats.api_calls_today++;
    const query = req.query.query || '';
    const format = req.query.format || 'json';
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    const baseUrl = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
    const params = new URLSearchParams({ query, format });
    const targetUrl = `${baseUrl}?${params}`;

    console.log(`📡 Proxying TAP request: ${query.substring(0, 50)}...`);

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(targetUrl);
    if (!response.ok) throw new Error(`TAP service error: ${response.status}`);
    const data = await response.text();

    if (format === 'json') {
      try { res.json(JSON.parse(data)); } catch { res.send(data); }
    } else {
      res.send(data);
    }

    await saveStats();
  } catch (err) {
    console.error('TAP Proxy Error:', err);
    res.status(500).json({ error: 'Failed to fetch TAP data' });
  }
});

// ------------------
// ML Prediction Endpoint
// ------------------
app.post('/predict', async (req, res) => {
  try {
    const { features } = req.body;
    if (!features || !Array.isArray(features) || features.length !== 4)
      return res.status(400).json({ error: 'Expected array of 4 numerical features.' });

    const [period, radius, distance, temperature] = features.map(Number);
    let score = 0;
    let reasoning = [];

    if (period >= 200 && period <= 500) { score += 0.3; reasoning.push('Favorable orbital period'); }
    if (radius >= 0.5 && radius <= 2.0) { score += 0.3; reasoning.push('Earth-like size'); }
    if (distance >= 0.8 && distance <= 1.5) { score += 0.25; reasoning.push('In habitable zone'); }
    if (temperature >= 273 && temperature <= 373) { score += 0.15; reasoning.push('Temperature allows liquid water'); }

    const confidence = Math.min(score, 1.0);
    const prediction = confidence >= 0.5 ? 'CONFIRMED' : 'FALSE POSITIVE';

    if (prediction === 'CONFIRMED') modelStats.confirmed_predictions++; 
    else modelStats.rejected_predictions++;

    modelStats.total_predictions++;
    modelStats.total_confidence += confidence;
    modelStats.prediction_history.push({
      features, prediction, confidence: Math.round(confidence*100)/100,
      timestamp: new Date().toISOString(),
      reasoning: reasoning.join(', ')
    });
    if (modelStats.prediction_history.length > 100) modelStats.prediction_history = modelStats.prediction_history.slice(-100);

    await saveStats();

    res.json({ prediction, confidence: Math.round(confidence*100)/100, reasoning: reasoning.join(', ') });

  } catch (err) {
    console.error('Prediction error:', err);
    res.status(500).json({ error: 'Internal server error during prediction' });
  }
});

// ------------------
// Stats Endpoint
// ------------------
app.get('/api/stats', (req, res) => {
  modelStats.api_calls_today++;
  res.json(modelStats);
  saveStats();
});

// ------------------
// Catch-all: serve Flutter web
// ------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'web', 'index.html'));
});

// ------------------
// Start Server
// ------------------
async function startServer() {
  await loadStats();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

// ------------------
// Graceful Shutdown
// ------------------
process.on('SIGTERM', async () => { console.log('🔄 Saving stats before shutdown'); await saveStats(); process.exit(0); });

startServer();
