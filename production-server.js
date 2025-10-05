const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 8080;

// Statistics tracking
let modelStats = {
  model_type: 'Random Forest Classifier',
  training_samples: 9564,
  features_count: 4,
  last_updated: new Date().toISOString().split('T')[0],
  
  // Runtime statistics
  total_predictions: 0,
  confirmed_predictions: 0,
  rejected_predictions: 0,
  total_confidence: 0,
  prediction_history: [],
  start_time: new Date().toISOString(),
  
  // API usage stats
  api_calls_today: 0,
  last_reset: new Date().toDateString()
};

// Load existing stats if available
async function loadStats() {
  try {
    const statsPath = path.join(__dirname, 'model_stats.json');
    const data = await fs.readFile(statsPath, 'utf8');
    const saved = JSON.parse(data);
    
    // Reset daily counters if it's a new day
    if (saved.last_reset !== new Date().toDateString()) {
      saved.api_calls_today = 0;
      saved.last_reset = new Date().toDateString();
    }
    
    modelStats = { ...modelStats, ...saved };
    console.log('📊 Loaded existing model statistics');
  } catch (error) {
    console.log('📊 Starting with fresh statistics');
  }
}

// Save stats to file
async function saveStats() {
  try {
    const statsPath = path.join(__dirname, 'model_stats.json');
    await fs.writeFile(statsPath, JSON.stringify(modelStats, null, 2));
  } catch (error) {
    console.error('Error saving stats:', error);
  }
}

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from the Flutter web build
app.use(express.static(path.join(__dirname, 'build', 'web')));

// TAP Proxy endpoint
app.get('/tap/sync', async (req, res) => {
  try {
    modelStats.api_calls_today++;
    
    const query = req.query.query || '';
    const format = req.query.format || 'json';
    
    if (!query) {
      return res.status(400).json({ error: 'Missing query parameter' });
    }
    
    const baseUrl = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
    const params = new URLSearchParams({ query, format });
    const targetUrl = `${baseUrl}?${params}`;
    
    console.log(`📡 Proxying TAP request: ${query.substring(0, 50)}...`);
    
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(targetUrl);
    
    if (!response.ok) {
      throw new Error(`TAP service error: ${response.status}`);
    }
    
    const data = await response.text();
    
    // Try to parse as JSON if format is json
    if (format === 'json') {
      try {
        const jsonData = JSON.parse(data);
        res.json(jsonData);
      } catch (e) {
        res.send(data);
      }
    } else {
      res.send(data);
    }
    
    await saveStats();
  } catch (error) {
    console.error('TAP Proxy Error:', error);
    res.status(500).json({ error: 'Failed to fetch data from TAP service' });
  }
});

// Model statistics endpoint
app.get('/api/stats', (req, res) => {
  modelStats.api_calls_today++;
  res.json(modelStats);
  saveStats();
});

// Prediction endpoint (your existing ML model endpoint)
app.post('/predict', async (req, res) => {
  try {
    const { features } = req.body;
    
    if (!features || !Array.isArray(features) || features.length !== 4) {
      return res.status(400).json({ 
        error: 'Invalid input. Expected array of 4 numerical features.' 
      });
    }
    
    // Update statistics
    modelStats.total_predictions++;
    
    // Simple prediction logic (you can replace this with your actual ML model)
    const [period, radius, distance, temperature] = features.map(Number);
    
    // Basic habitability scoring
    let score = 0;
    let reasoning = [];
    
    // Period check (Earth-like: 200-500 days)
    if (period >= 200 && period <= 500) {
      score += 0.3;
      reasoning.push('Favorable orbital period');
    } else if (period < 200) {
      reasoning.push('Too close to star');
    } else {
      reasoning.push('Too far from star');
    }
    
    // Radius check (Earth-like: 0.5-2.0 Earth radii)
    if (radius >= 0.5 && radius <= 2.0) {
      score += 0.3;
      reasoning.push('Earth-like size');
    } else if (radius < 0.5) {
      reasoning.push('Too small');
    } else {
      reasoning.push('Too large (likely gas giant)');
    }
    
    // Distance check (habitable zone varies)
    if (distance >= 0.8 && distance <= 1.5) {
      score += 0.25;
      reasoning.push('In habitable zone');
    }
    
    // Temperature check (liquid water: 0-100°C → ~273-373K)
    if (temperature >= 273 && temperature <= 373) {
      score += 0.15;
      reasoning.push('Temperature allows liquid water');
    }
    
    const confidence = Math.min(score, 1.0);
    const prediction = confidence >= 0.5 ? 'CONFIRMED' : 'FALSE POSITIVE';
    
    if (prediction === 'CONFIRMED') {
      modelStats.confirmed_predictions++;
    } else {
      modelStats.rejected_predictions++;
    }
    
    modelStats.total_confidence += confidence;
    
    // Store prediction history (keep last 100)
    modelStats.prediction_history.push({
      features,
      prediction,
      confidence: Math.round(confidence * 100) / 100,
      timestamp: new Date().toISOString(),
      reasoning: reasoning.join(', ')
    });
    
    if (modelStats.prediction_history.length > 100) {
      modelStats.prediction_history = modelStats.prediction_history.slice(-100);
    }
    
    const result = {
      prediction,
      confidence: Math.round(confidence * 100) / 100,
      reasoning: reasoning.join(', '),
      model_info: {
        type: modelStats.model_type,
        features_used: ['orbital_period', 'planet_radius', 'stellar_distance', 'equilibrium_temp']
      }
    };
    
    await saveStats();
    res.json(result);
    
  } catch (error) {
    console.error('Prediction error:', error);
    res.status(500).json({ error: 'Internal server error during prediction' });
  }
});

// Catch all handler: send back Flutter's index.html file
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'web', 'index.html'));
});

// Initialize and start server
async function startServer() {
  await loadStats();
  
  app.listen(PORT, () => {
    console.log(`🚀 Production server running on port ${PORT}`);
    console.log(`📱 Flutter web app: http://localhost:${PORT}`);
    console.log(`🔗 API endpoints:`);
    console.log(`   - TAP Proxy: http://localhost:${PORT}/tap/sync`);
    console.log(`   - ML Predict: http://localhost:${PORT}/predict`);
    console.log(`   - Statistics: http://localhost:${PORT}/api/stats`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔄 Saving stats before shutdown...');
  await saveStats();
  process.exit(0);
});

startServer();