const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Paynow } = require('paynow');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const dataDir = path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'cws_sid',
  secret: process.env.SESSION_SECRET || 'kinton-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', apiLimiter);

const paynowConfigReady = Boolean(process.env.PAYNOW_INTEGRATION_ID && process.env.PAYNOW_INTEGRATION_KEY);
let paynow = null;

if (paynowConfigReady) {
  paynow = new Paynow(
    process.env.PAYNOW_INTEGRATION_ID,
    process.env.PAYNOW_INTEGRATION_KEY
  );

  paynow.resultUrl = `http://localhost:${PORT}/api/paynow/update`;
  paynow.returnUrl = `http://localhost:${PORT}/thank-you.html`;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    service_name TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_method TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const adminEmail = process.env.ADMIN_EMAIL || 'admin@kinton.co.zw';
const adminPassword = process.env.ADMIN_PASSWORD || 'KintonAdmin2026!';
const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
if (!adminExists) {
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
    'Kinton Admin',
    adminEmail,
    bcrypt.hashSync(adminPassword, 12),
    'admin'
  );
}

function getSessionUser(req) {
  return req.session && req.session.user ? req.session.user : null;
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }
  next();
}

app.get('/api/session', (req, res) => {
  const user = getSessionUser(req);
  res.json({ authenticated: !!user, user: user || null });
});

app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: 'Name, email and password are required.' });
  }

  const trimmedEmail = String(email).trim().toLowerCase();
  const trimmedName = String(name).trim();

  if (trimmedName.length < 2) {
    return res.status(400).json({ success: false, message: 'Name must be at least 2 characters long.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(trimmedEmail);
  if (existing) {
    return res.status(409).json({ success: false, message: 'An account with that email already exists.' });
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const result = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(trimmedName, trimmedEmail, passwordHash, 'user');

  const newUser = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(result.lastInsertRowid);
  req.session.user = newUser;

  res.status(201).json({ success: true, user: newUser });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  const user = db.prepare('SELECT id, name, email, password_hash, role FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }

  const passwordMatches = bcrypt.compareSync(String(password), user.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }

  const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  req.session.user = safeUser;
  res.json({ success: true, user: safeUser });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY id DESC').all();
  res.json({ success: true, users });
});

app.get('/api/orders', requireAuth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  res.json({ success: true, orders });
});

app.post('/api/checkout', requireAuth, async (req, res) => {
  try {
    if (!paynow) {
      return res.status(503).json({ success: false, message: 'Paynow credentials are not configured yet.' });
    }

    const { serviceName, amount, paymentMethod, phone } = req.body || {};
    if (!serviceName || !amount) {
      return res.status(400).json({ success: false, message: 'Service name and amount are required.' });
    }

    const payment = paynow.createPayment(`Order: ${serviceName}`, req.session.user.email);
    payment.add(serviceName, Number(amount));

    let response;
    if (paymentMethod === 'ecocash' || paymentMethod === 'innbucks') {
      if (!phone) {
        return res.status(400).json({ success: false, message: 'Phone number is required for mobile money.' });
      }
      response = await paynow.sendMobile(payment, phone, paymentMethod);
    } else {
      response = await paynow.send(payment);
    }

    if (response.success) {
      db.prepare('INSERT INTO orders (user_id, service_name, amount, status, payment_method) VALUES (?, ?, ?, ?, ?)').run(
        req.session.user.id,
        serviceName,
        Number(amount),
        'pending',
        paymentMethod || 'paynow'
      );

      return res.json({
        success: true,
        redirectUrl: response.redirectUrl || null,
        instructions: response.instructions || 'Transaction initiated successfully.'
      });
    }

    return res.status(400).json({ success: false, message: response.error || 'Failed to initiate payment.' });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ success: false, message: 'Payment processing failed. Please try again.' });
  }
});

app.post('/api/paynow/update', (req, res) => {
  console.log('Paynow update payload:', req.body);
  res.status(200).send('OK');
});

app.get('/dashboard.html', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login.html');
  }
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/login.html', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard.html');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/signup.html', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard.html');
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`CWS Multimedia Connect server running at http://localhost:${PORT}`);
  console.log(`Admin login: ${adminEmail} / ${adminPassword}`);
});
