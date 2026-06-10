require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Datenbank
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Session Konfiguration
app.use(session({
  secret: crypto.randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Datenbank initialisieren
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS velo_visitors (
        id SERIAL PRIMARY KEY,
        ip_address VARCHAR(45),
        user_agent TEXT,
        browser TEXT,
        os TEXT,
        device TEXT,
        country VARCHAR(100),
        city VARCHAR(100),
        region VARCHAR(100),
        isp VARCHAR(200),
        org VARCHAR(200),
        asn VARCHAR(50),
        latitude DECIMAL(10,8),
        longitude DECIMAL(11,8),
        timezone VARCHAR(100),
        visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        visit_count INTEGER DEFAULT 1,
        last_page TEXT,
        session_id VARCHAR(100)
      );

      CREATE TABLE IF NOT EXISTS velo_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE,
        email VARCHAR(100) UNIQUE,
        password_hash VARCHAR(255),
        role VARCHAR(20) DEFAULT 'user',
        avatar VARCHAR(255),
        discord_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS velo_tracking_logs (
        id SERIAL PRIMARY KEY,
        ip_address VARCHAR(45),
        action VARCHAR(100),
        page_url TEXT,
        referer TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      );

      CREATE TABLE IF NOT EXISTS velo_discord_support (
        id SERIAL PRIMARY KEY,
        user_email VARCHAR(100),
        discord_tag VARCHAR(100),
        ticket_id VARCHAR(50) UNIQUE,
        status VARCHAR(20) DEFAULT 'open',
        priority VARCHAR(10) DEFAULT 'normal',
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP
      );

      -- Admin User erstellen
      INSERT INTO velo_users (username, email, password_hash, role)
      VALUES ('VeloAdmin', 'admin@veloservices.de', 'Paul111', 'admin')
      ON CONFLICT (email) DO NOTHING;

      -- Demo Daten für Statistiken
      INSERT INTO velo_visitors (ip_address, country, city, isp, browser, os, device, visit_count)
      VALUES 
        ('343.34.343.1', 'Germany', 'Berlin', 'Deutsche Telekom', 'Chrome', 'Windows', 'Desktop', 343),
        ('198.51.100.42', 'United States', 'New York', 'Cloudflare', 'Firefox', 'macOS', 'Desktop', 847),
        ('203.0.113.99', 'Japan', 'Tokyo', 'NTT Communications', 'Edge', 'Windows', 'Laptop', 234)
      ON CONFLICT DO NOTHING;
    `);
    console.log('✅ VeloServices Datenbank initialisiert');
  } finally {
    client.release();
  }
}

// Middleware für Tracking
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/public/')) {
    return next();
  }

  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] ||
      req.socket.remoteAddress || '127.0.0.1';

  try {
    const client = await pool.connect();
    await client.query(
        `INSERT INTO velo_tracking_logs (ip_address, action, page_url, referer, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
        [
          clientIP,
          'page_view',
          req.originalUrl,
          req.headers.referer || 'direct',
          JSON.stringify({
            userAgent: req.headers['user-agent'],
            language: req.headers['accept-language'],
            method: req.method
          })
        ]
    );
    client.release();
  } catch (error) {
    // Leise tracken ohne Fehler
  }
  next();
});

// Auth Middleware
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  res.status(403).render('error', {
    message: '🚫 Zugriff verweigert! Nur für Administratoren.',
    code: 403
  });
}

// ============ ROUTEN ============

// Homepage
app.get('/', async (req, res) => {
  try {
    const client = await pool.connect();
    const stats = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM velo_visitors) as total_visitors,
        (SELECT COUNT(DISTINCT ip_address) FROM velo_visitors) as unique_ips,
        (SELECT COUNT(*) FROM velo_tracking_logs WHERE timestamp > NOW() - INTERVAL '24 hours') as today_visits
    `);
    client.release();

    res.render('index', {
      user: req.session.user,
      stats: stats.rows[0],
      title: 'VeloServices - Premium Cyber Security'
    });
  } catch (error) {
    res.render('index', { user: req.session.user, stats: {}, title: 'VeloServices' });
  }
});

// Services
app.get('/services', (req, res) => {
  res.render('services', {
    user: req.session.user,
    title: 'Services - VeloServices'
  });
});

// IP-Tracker
app.get('/ip-tracker', (req, res) => {
  res.render('ip-tracker', {
    user: req.session.user,
    title: 'IP-Tracker - VeloServices'
  });
});

// Discord Support
app.get('/discord', (req, res) => {
  res.render('discord', {
    user: req.session.user,
    title: 'Discord Support - VeloServices'
  });
});

// Login
app.get('/login', (req, res) => {
  res.render('login', {
    user: req.session.user,
    error: null,
    title: 'Login - VeloServices'
  });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const client = await pool.connect();
    const result = await client.query(
        'SELECT * FROM velo_users WHERE email = $1 AND password_hash = $2 AND is_active = true',
        [email, password]
    );
    client.release();

    if (result.rows.length > 0) {
      const user = result.rows[0];
      req.session.user = {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        discord_id: user.discord_id
      };

      // Last Login updaten
      await pool.query('UPDATE velo_users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

      res.redirect('/dashboard');
    } else {
      res.render('login', {
        user: null,
        error: '❌ Ungültige Anmeldedaten! Bitte überprüfe Email und Passwort.',
        title: 'Login - VeloServices'
      });
    }
  } catch (error) {
    res.render('login', {
      user: null,
      error: '⚠️ Server-Fehler! Bitte versuche es später erneut.',
      title: 'Login - VeloServices'
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', requireAuth, requireAdmin, async (req, res) => {
  try {
    const client = await pool.connect();

    const visitors = await client.query(
        'SELECT * FROM velo_visitors ORDER BY visited_at DESC LIMIT 100'
    );

    const stats = await client.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(DISTINCT ip_address) as unique_ips,
        COUNT(DISTINCT country) as countries,
        COUNT(DISTINCT city) as cities,
        (SELECT COUNT(*) FROM velo_tracking_logs WHERE timestamp > NOW() - INTERVAL '1 hour') as last_hour,
        (SELECT COUNT(*) FROM velo_tracking_logs WHERE timestamp > NOW() - INTERVAL '24 hours') as last_24h,
        (SELECT COUNT(*) FROM velo_tracking_logs WHERE timestamp > NOW() - INTERVAL '7 days') as last_7d
      FROM velo_visitors
    `);

    const recentLogs = await client.query(
        'SELECT * FROM velo_tracking_logs ORDER BY timestamp DESC LIMIT 50'
    );

    const tickets = await client.query(
        "SELECT * FROM velo_discord_support WHERE status = 'open' ORDER BY created_at DESC"
    );

    client.release();

    res.render('dashboard', {
      user: req.session.user,
      visitors: visitors.rows,
      stats: stats.rows[0],
      logs: recentLogs.rows,
      tickets: tickets.rows,
      title: 'Admin Dashboard - VeloServices'
    });
  } catch (error) {
    res.status(500).render('error', { message: 'Fehler beim Laden des Dashboards', code: 500 });
  }
});

// API Endpoints
app.post('/api/track', async (req, res) => {
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] ||
      req.socket.remoteAddress;

  try {
    // IP-Informationen abrufen
    const geoResponse = await fetch(`http://ip-api.com/json/${clientIP}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
    const geoData = await geoResponse.json();

    const client = await pool.connect();

    // Prüfen ob IP existiert
    const existing = await client.query(
        'SELECT * FROM velo_visitors WHERE ip_address = $1',
        [clientIP]
    );

    if (existing.rows.length > 0) {
      await client.query(
          `UPDATE velo_visitors 
         SET visit_count = visit_count + 1, 
             visited_at = CURRENT_TIMESTAMP,
             last_page = $2,
             user_agent = $3
         WHERE ip_address = $1`,
          [clientIP, req.body.page || '/', req.headers['user-agent']]
      );
    } else {
      await client.query(
          `INSERT INTO velo_visitors (
          ip_address, user_agent, country, city, region, isp, org,
          latitude, longitude, timezone, last_page
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            clientIP,
            req.headers['user-agent'],
            geoData.country || 'Unknown',
            geoData.city || 'Unknown',
            geoData.regionName || 'Unknown',
            geoData.isp || 'Unknown',
            geoData.org || 'Unknown',
            geoData.lat || 0,
            geoData.lon || 0,
            geoData.timezone || 'Unknown',
            req.body.page || '/'
          ]
      );
    }

    client.release();

    res.json({
      success: true,
      ip: clientIP,
      geo: {
        country: geoData.country,
        city: geoData.city,
        region: geoData.regionName,
        isp: geoData.isp,
        timezone: geoData.timezone,
        coordinates: `${geoData.lat}, ${geoData.lon}`
      }
    });
  } catch (error) {
    res.json({ success: false, error: 'Tracking fehlgeschlagen' });
  }
});

// Discord Ticket erstellen
app.post('/api/discord/ticket', async (req, res) => {
  const { email, discord_tag, message } = req.body;
  const ticketId = 'VELO-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  try {
    const client = await pool.connect();
    await client.query(
        `INSERT INTO velo_discord_support (user_email, discord_tag, ticket_id, message)
       VALUES ($1, $2, $3, $4)`,
        [email, discord_tag, ticketId, message]
    );
    client.release();

    res.json({
      success: true,
      ticket_id: ticketId,
      message: '🎫 Support-Ticket erstellt! Unser Team meldet sich auf Discord.'
    });
  } catch (error) {
    res.json({ success: false, error: 'Fehler beim Erstellen des Tickets' });
  }
});

// API: Statistiken
app.get('/api/stats', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM velo_visitors) as total_visitors,
        (SELECT COUNT(DISTINCT ip_address) FROM velo_visitors) as unique_ips,
        (SELECT COUNT(DISTINCT country) FROM velo_visitors) as countries,
        (SELECT COUNT(*) FROM velo_tracking_logs WHERE timestamp > NOW() - INTERVAL '24 hours') as today,
        (SELECT COUNT(*) FROM velo_discord_support WHERE status = 'open') as open_tickets
    `);
    client.release();
    res.json(result.rows[0]);
  } catch (error) {
    res.json({ error: true });
  }
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`
╔══════════════════════════════════════╗
║   🚀 VeloServices ist online!       ║
║   📡 Port: ${PORT}                      ║
║   🌐 http://localhost:${PORT}          ║
║   🔐 Admin: admin@veloservices.de   ║
╚══════════════════════════════════════╝
  `);
});