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
app.post('/ai/predict', async (req, res) => {
  try {
    console.log('🤖 AI prediction request:', req.body);
    
    const response = await fetch('https://exoplanetapi.onrender.com/api/predict', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      throw new Error(`AI API responded with status: ${response.status}`);
    }

    const data = await response.json();
    console.log('🤖 AI prediction response:', data);
    
    // Update statistics
    modelStats.total_predictions += 1;
    modelStats.api_calls_today += 1;
    
    if (data.confidence !== undefined) {
      modelStats.total_confidence += data.confidence;
      
      // Track predictions (assuming >50% confidence means "confirmed")
      if (data.confidence > 0.5) {
        modelStats.confirmed_predictions += 1;
      } else {
        modelStats.rejected_predictions += 1;
      }
    }
    
    // Keep last 100 predictions for history
    const prediction = {
      timestamp: new Date().toISOString(),
      input: req.body,
      output: data,
      confidence: data.confidence || 0
    };
    
    modelStats.prediction_history.unshift(prediction);
    if (modelStats.prediction_history.length > 100) {
      modelStats.prediction_history = modelStats.prediction_history.slice(0, 100);
    }
    
    // Save stats asynchronously (don't wait)
    saveStats();
    
    res.json(data);
    
  } catch (error) {
    console.error('❌ AI API Error:', error.message);
    res.status(500).json({ 
      error: 'AI prediction failed', 
      details: error.message 
    });
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
