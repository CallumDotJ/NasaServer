// This Node server consolidates the previous Python CORS proxy (proxy_server.py)
// and the Node API into a single service. The Flask-based `proxy_server.py` has
// been removed to avoid running two proxy servers. All TAP proxying and API
// endpoints are handled below.
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = 3001;

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
    console.error('Failed to save statistics:', error.message);
  }
}

// Initialize stats on startup
loadStats();

// Enable CORS for all routes
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// Base URL for NASA TAP service
const TAP_BASE_URL = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'NASA TAP proxy server is running',
    timestamp: new Date().toISOString()
  });
});

// Generic TAP proxy endpoint
app.get('/tap/sync', async (req, res) => {
  try {
    const { query, format = 'json' } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Missing query parameter' });
    }

    // Build the target URL with query parameters
    const params = new URLSearchParams({ query, format });
    const targetUrl = `${TAP_BASE_URL}?${params.toString()}`;
    
    console.log(`Proxying request to: ${targetUrl}`);
    
    // Dynamically import node-fetch (ES module)
    const fetch = (await import('node-fetch')).default;
    
    // Make the request to NASA TAP service
    const response = await fetch(targetUrl);
    
    if (!response.ok) {
      throw new Error(`NASA TAP service error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json';
    
    // Return the response with appropriate content type
    res.set('Content-Type', contentType);
    res.send(data);
    
  } catch (error) {
    console.error('Error proxying request:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch from NASA TAP service',
      message: error.message 
    });
  }
});

// Simplified endpoints for direct exoplanet data access
app.get('/exoplanets/confirmed', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const query = limit 
      ? `SELECT TOP ${limit} * FROM ps`
      : 'SELECT * FROM ps';
    
    req.query = { query, format: 'json' };
    // Reuse the TAP sync handler
    return app._router.handle({ ...req, url: '/tap/sync', method: 'GET' }, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/exoplanets/candidates', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const query = limit 
      ? `SELECT TOP ${limit} * FROM cumulative WHERE koi_disposition = 'CANDIDATE'`
      : `SELECT * FROM cumulative WHERE koi_disposition = 'CANDIDATE'`;
    
    req.query = { query, format: 'json' };
    // Reuse the TAP sync handler  
    return app._router.handle({ ...req, url: '/tap/sync', method: 'GET' }, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/exoplanets/false-positives', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const query = limit 
      ? `SELECT TOP ${limit} * FROM cumulative WHERE koi_disposition = 'FALSE POSITIVE'`
      : `SELECT * FROM cumulative WHERE koi_disposition = 'FALSE POSITIVE'`;
    
    req.query = { query, format: 'json' };
    // Reuse the TAP sync handler
    return app._router.handle({ ...req, url: '/tap/sync', method: 'GET' }, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI API Proxy endpoint with statistics tracking
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

// Model Statistics endpoint with real data
app.get('/ai/stats', async (req, res) => {
  try {
    console.log('📊 Model statistics request');
    
    // Calculate average confidence
    const avg_confidence = modelStats.total_predictions > 0 
      ? modelStats.total_confidence / modelStats.total_predictions 
      : 0;
    
    // Calculate uptime
    const startTime = new Date(modelStats.start_time);
    const uptime = Date.now() - startTime.getTime();
    const uptimeHours = Math.round(uptime / (1000 * 60 * 60) * 100) / 100;
    
    // Calculate recent activity (last 24 hours)
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent_predictions = modelStats.prediction_history.filter(
      p => new Date(p.timestamp) > last24h
    ).length;
    
    const stats = {
      // Model info
      model_type: modelStats.model_type,
      training_samples: modelStats.training_samples,
      features_count: modelStats.features_count,
      last_updated: modelStats.last_updated,
      
      // Performance metrics (from training)
      accuracy: modelStats.accuracy,
      precision: modelStats.precision,
      recall: modelStats.recall,
      f1_score: modelStats.f1_score,
      
      // Runtime statistics
      total_predictions: modelStats.total_predictions,
      confirmed_predictions: modelStats.confirmed_predictions,
      rejected_predictions: modelStats.rejected_predictions,
      avg_confidence: Math.round(avg_confidence * 10000) / 10000,
      
      // Usage statistics
      api_calls_today: modelStats.api_calls_today,
      recent_predictions_24h: recent_predictions,
      uptime_hours: uptimeHours,
      
      // Additional insights
      confirmation_rate: modelStats.total_predictions > 0 
        ? Math.round((modelStats.confirmed_predictions / modelStats.total_predictions) * 100) / 100
        : 0,
      
      last_prediction: modelStats.prediction_history.length > 0 
        ? modelStats.prediction_history[0].timestamp 
        : null
    };
    
    console.log('📊 Returning real model statistics');
    res.json(stats);
    
  } catch (error) {
    console.error('❌ Model Stats Error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch model statistics', 
      details: error.message 
    });
  }
});

// Reset statistics endpoint (for development/testing)
app.post('/ai/stats/reset', async (req, res) => {
  try {
    const resetStats = {
      ...modelStats,
      total_predictions: 0,
      confirmed_predictions: 0,
      rejected_predictions: 0,
      total_confidence: 0,
      prediction_history: [],
      api_calls_today: 0,
      start_time: new Date().toISOString(),
      last_reset: new Date().toDateString()
    };
    
    modelStats = resetStats;
    await saveStats();
    
    console.log('📊 Statistics reset');
    res.json({ message: 'Statistics reset successfully', stats: modelStats });
    
  } catch (error) {
    console.error('❌ Stats Reset Error:', error.message);
    res.status(500).json({ 
      error: 'Failed to reset statistics', 
      details: error.message 
    });
  }
});

// Start the server
app.listen(PORT, '127.0.0.1', () => {
  console.log('🚀 NASA TAP CORS proxy server started');
  console.log(`📡 Server running at: http://localhost:${PORT}`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 TAP endpoint: http://localhost:${PORT}/tap/sync`);
  console.log(`🪐 Direct endpoints:`);
  console.log(`   • Confirmed: http://localhost:${PORT}/exoplanets/confirmed`);
  console.log(`   • Candidates: http://localhost:${PORT}/exoplanets/candidates`);
  console.log(`   • False Positives: http://localhost:${PORT}/exoplanets/false-positives`);
  console.log('📝 Press Ctrl+C to stop');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down NASA TAP proxy server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down NASA TAP proxy server...');
  process.exit(0);
});