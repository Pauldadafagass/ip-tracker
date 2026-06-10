require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();

// PostgreSQL Verbindung
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tabelle erstellen
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        id SERIAL PRIMARY KEY,
        ip_address VARCHAR(45),
        user_agent TEXT,
        language VARCHAR(10),
        platform VARCHAR(50),
        screen_resolution VARCHAR(20),
        referer TEXT,
        country VARCHAR(50),
        city VARCHAR(100),
        isp VARCHAR(200),
        visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        visit_count INTEGER DEFAULT 1
      )
    `);
    console.log('✅ Datenbank bereit');
  } finally {
    client.release();
  }
}

// IP-Daten abrufen
async function getIPInfo(ip) {
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}`);
    return await response.json();
  } catch {
    return {};
  }
}

// Statische Dateien
app.use(express.static('public'));
app.use(express.json());
app.set('view engine', 'ejs');

// IP speichern
app.post('/api/save-ip', async (req, res) => {
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] ||
                   req.socket.remoteAddress ||
                   '127.0.0.1';

  const userAgent = req.headers['user-agent'];
  const { language, platform, screenResolution, referer } = req.body;

  // IP-Informationen holen
  const ipInfo = await getIPInfo(clientIP);

  try {
    const client = await pool.connect();

    // Prüfen ob IP schon existiert
    const existing = await client.query(
      'SELECT * FROM visitors WHERE ip_address = $1',
      [clientIP]
    );

    if (existing.rows.length > 0) {
      // Update visit count
      await client.query(
        'UPDATE visitors SET visit_count = visit_count + 1, visited_at = CURRENT_TIMESTAMP WHERE ip_address = $1',
        [clientIP]
      );
    } else {
      // Neue IP speichern
      await client.query(
        `INSERT INTO visitors (ip_address, user_agent, language, platform, screen_resolution, referer, country, city, isp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          clientIP,
          userAgent,
          language,
          platform,
          screenResolution,
          referer,
          ipInfo.country || 'Unbekannt',
          ipInfo.city || 'Unbekannt',
          ipInfo.isp || 'Unbekannt'
        ]
      );
    }

    client.release();

    res.json({
      success: true,
      ip: clientIP,
      country: ipInfo.country,
      city: ipInfo.city,
      message: 'IP erfolgreich gespeichert'
    });

  } catch (error) {
    console.error('Fehler:', error);
    res.status(500).json({ error: 'Server-Fehler' });
  }
});

// Admin-Seite (alle gespeicherten IPs anzeigen)
app.get('/admin', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM visitors ORDER BY visited_at DESC LIMIT 100'
    );
    client.release();
    res.render('admin', { visitors: result.rows });
  } catch (error) {
    res.status(500).send('Fehler beim Laden');
  }
});

// Hauptseite
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});