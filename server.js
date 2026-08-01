import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      last_spin TEXT,
      is_banned INTEGER DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS prizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      icon TEXT,
      rarity TEXT,
      weight INTEGER,
      promo_prefix TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      prize_name TEXT,
      icon TEXT,
      promo TEXT,
      won_at TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      is_super INTEGER DEFAULT 0
    )
  `);

  await db.execute(`DELETE FROM users WHERE username IS NULL OR username = '' OR username = 'null'`);

  const adminCheck = await db.execute(`SELECT COUNT(*) as count FROM admins`);
  if (adminCheck.rows[0].count === 0) {
    await db.execute({
      sql: `INSERT INTO admins (username, is_super) VALUES (?, ?)`,
      args: ['ropogku', 1]
    });
  } else {
    // Гарантируем, что ropogku всегда супер-админ в базе
    await db.execute({
      sql: `UPDATE admins SET is_super = 1 WHERE LOWER(username) = 'ropogku'`,
      args: []
    });
  }
}
initDb();

async function verifyAdmin(username) {
  if (!username) return { isAdmin: false, isSuper: false };
  const clean = username.replace('@', '').toLowerCase();
  
  if (clean === 'ropogku') {
    return { isAdmin: true, isSuper: true };
  }

  const res = await db.execute({
    sql: `SELECT * FROM admins WHERE LOWER(username) = ?`,
    args: [clean]
  });
  if (res.rows.length === 0) return { isAdmin: false, isSuper: false };
  return {
    isAdmin: true,
    isSuper: res.rows[0].is_super === 1
  };
}

app.get('/api/status', async (req, res) => {
  try {
    const { userId, username } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const cleanUsername = username ? username.replace('@', '').toLowerCase() : '';
    if (!cleanUsername) return res.status(400).json({ error: 'Missing username' });

    let userRes = await db.execute({
      sql: `SELECT * FROM users WHERE username = ? OR id = ?`,
      args: [cleanUsername, String(userId)]
    });

    let user = userRes.rows[0];

    if (!user) {
      res.json({ isBanned: false, canSpin: true });
      return;
    }

    if (user.is_banned === 1 && cleanUsername !== 'ropogku') {
      return res.json({ isBanned: true });
    }

    let canSpin = true;
    let nextSpinTime = '';

    if (user.last_spin) {
      const lastSpinDate = new Date(user.last_spin);
      const nextAllowedDate = new Date(lastSpinDate.getTime() + 24 * 60 * 60 * 1000);
      const now = new Date();

      if (now < nextAllowedDate) {
        canSpin = false;
        nextSpinTime = nextAllowedDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
      }
    }

    res.json({ isBanned: false, canSpin, nextSpinTime });
  } catch (e) {
    console.error('API Status Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/check', async (req, res) => {
  try {
    const { username } = req.query;
    const adminData = await verifyAdmin(username);
    res.json(adminData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/spin', async (req, res) => {
  try {
    const { userId, username } = req.body;
    const cleanUsername = username ? username.replace('@', '').toLowerCase() : '';
    if (!cleanUsername) return res.status(400).json({ error: 'Missing username' });

    let userRes = await db.execute({
      sql: `SELECT * FROM users WHERE username = ? OR id = ?`,
      args: [cleanUsername, String(userId)]
    });

    let user = userRes.rows[0];

    if (user && user.is_banned === 1 && cleanUsername !== 'ropogku') {
      return res.status(403).json({ isBanned: true, error: 'Аккаунт заблокирован' });
    }

    if (user && user.last_spin) {
      const lastSpinDate = new Date(user.last_spin);
      const nextAllowedDate = new Date(lastSpinDate.getTime() + 24 * 60 * 60 * 1000);
      if (new Date() < nextAllowedDate) {
        return res.status(400).json({ error: 'Кейс можно открывать раз в 24 часа' });
      }
    }

    const prizesRes = await db.execute(`SELECT * FROM prizes`);
    const prizes = prizesRes.rows;
    if (prizes.length === 0) {
      return res.status(400).json({ error: 'Призы не настроены администратором' });
    }

    let totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
    let randomWeight = Math.random() * totalWeight;
    let chosenPrize = prizes[0];

    for (let p of prizes) {
      if (randomWeight < p.weight) {
        chosenPrize = p;
        break;
      }
      randomWeight -= p.weight;
    }

    const promoCode = `${chosenPrize.promo_prefix || 'CYBER'}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const nowIso = new Date().toISOString();

    if (user) {
      await db.execute({
        sql: `UPDATE users SET last_spin = ?, id = ? WHERE username = ?`,
        args: [nowIso, String(userId), cleanUsername]
      });
    } else {
      await db.execute({
        sql: `INSERT INTO users (id, username, last_spin, is_banned) VALUES (?, ?, ?, 0)`,
        args: [String(userId), cleanUsername, nowIso]
      });
    }

    await db.execute({
      sql: `INSERT INTO inventory (user_id, prize_name, icon, promo, won_at) VALUES (?, ?, ?, ?, ?)`,
      args: [String(userId), chosenPrize.name, chosenPrize.icon || '🎁', promoCode, nowIso]
    });

    res.json({
      prize: {
        name: chosenPrize.name,
        icon: chosenPrize.icon,
        rarity: chosenPrize.rarity
      },
      promo: promoCode
    });
  } catch (e) {
    console.error('Spin Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/inventory', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.json({ items: [] });

    const itemsRes = await db.execute({
      sql: `SELECT * FROM inventory WHERE user_id = ? ORDER BY id DESC`,
      args: [String(userId)]
    });

    const now = new Date();
    const validItems = [];

    for (const item of itemsRes.rows) {
      const wonAt = new Date(item.won_at);
      const diffHours = (now - wonAt) / (1000 * 60 * 60);

      if (diffHours >= 48) {
        await db.execute({
          sql: `DELETE FROM inventory WHERE id = ?`,
          args: [item.id]
        });
      } else {
        validItems.push({
          ...item,
          hoursLeft: Math.ceil(48 - diffHours)
        });
      }
    }

    res.json({ items: validItems });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/inventory/delete', async (req, res) => {
  try {
    const { userId, itemId } = req.body;
    if (!userId || !itemId) return res.status(400).json({ error: 'Missing parameters' });

    await db.execute({
      sql: `DELETE FROM inventory WHERE id = ? AND user_id = ?`,
      args: [itemId, String(userId)]
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/prizes', async (req, res) => {
  try {
    const { username } = req.query;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const prizesRes = await db.execute(`SELECT * FROM prizes`);
    res.json({ prizes: prizesRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/add-prize', async (req, res) => {
  try {
    const { username, name, icon, rarity, weight, promo_prefix } = req.body;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    await db.execute({
      sql: `INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)`,
      args: [name, icon || '🎁', rarity || 'common', Number(weight) || 1, promo_prefix || 'PROMO']
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/delete-prize', async (req, res) => {
  try {
    const { username, prizeId } = req.body;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    await db.execute({
      sql: `DELETE FROM prizes WHERE id = ?`,
      args: [prizeId]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/update-prize', async (req, res) => {
  try {
    const { username, prizeId, weight } = req.body;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    await db.execute({
      sql: `UPDATE prizes SET weight = ? WHERE id = ?`,
      args: [Number(weight), prizeId]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const { username } = req.query;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const usersCount = await db.execute(`SELECT COUNT(*) as count FROM users WHERE username IS NOT NULL AND username != ''`);
    const bannedCount = await db.execute(`SELECT COUNT(*) as count FROM users WHERE is_banned = 1`);
    const spinsCount = await db.execute(`SELECT COUNT(*) as count FROM inventory`);

    res.json({
      totalUsers: usersCount.rows[0].count,
      bannedUsers: bannedCount.rows[0].count,
      totalSpins: spinsCount.rows[0].count
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/banned-list', async (req, res) => {
  try {
    const { username } = req.query;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const banned = await db.execute(`SELECT username FROM users WHERE is_banned = 1 AND username IS NOT NULL AND LOWER(username) != 'ropogku'`);
    res.json({ bannedUsers: banned.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users-list', async (req, res) => {
  try {
    const { username } = req.query;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const users = await db.execute(`SELECT id, username, is_banned FROM users WHERE username IS NOT NULL AND username != ''`);
    res.json({ users: users.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/ban', async (req, res) => {
  try {
    const { username, targetUsername, banState } = req.body;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const cleanUser = targetUsername.replace('@', '').toLowerCase();
    
    if (cleanUser === 'ropogku') {
      return res.status(400).json({ error: 'Нельзя заблокировать главного администратора' });
    }

    await db.execute({
      sql: `UPDATE users SET is_banned = ? WHERE LOWER(username) = ?`,
      args: [Number(banState), cleanUser]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/delete-user', async (req, res) => {
  try {
    const { username, targetIdentifier } = req.body;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const cleanUser = targetIdentifier ? String(targetIdentifier).replace('@', '').toLowerCase() : '';
    
    if (cleanUser === 'ropogku') {
      return res.status(400).json({ error: 'Нельзя удалить главного администратора' });
    }

    const userRes = await db.execute({
      sql: `SELECT id FROM users WHERE LOWER(username) = ? OR id = ?`,
      args: [cleanUser, String(targetIdentifier)]
    });

    if (userRes.rows.length > 0) {
      const foundUserId = userRes.rows[0].id;
      await db.execute({
        sql: `DELETE FROM inventory WHERE user_id = ?`,
        args: [foundUserId]
      });
    }

    await db.execute({
      sql: `DELETE FROM users WHERE LOWER(username) = ? OR id = ?`,
      args: [cleanUser, String(targetIdentifier)]
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-timer', async (req, res) => {
  try {
    const { username, targetUsername } = req.body;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const cleanUser = targetUsername.replace('@', '').toLowerCase();
    await db.execute({
      sql: `UPDATE users SET last_spin = NULL WHERE LOWER(username) = ?`,
      args: [cleanUser]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/list', async (req, res) => {
  try {
    const { username } = req.query;
    const admin = await verifyAdmin(username);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const admins = await db.execute(`SELECT username, is_super FROM admins`);
    res.json({ admins: admins.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/add-admin', async (req, res) => {
  try {
    const { username, newAdminUsername } = req.body;
    const admin = await verifyAdmin(username);
    if (!admin.isSuper) return res.status(403).json({ error: 'Only super admin can add admins' });

    const cleanUser = newAdminUsername.replace('@', '').toLowerCase();
    await db.execute({
      sql: `INSERT OR IGNORE INTO admins (username, is_super) VALUES (?, 0)`,
      args: [cleanUser]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/remove-admin', async (req, res) => {
  try {
    const { username, targetAdminUsername } = req.body;
    const admin = await verifyAdmin(username);
    if (!admin.isSuper) return res.status(403).json({ error: 'Only super admin can remove admins' });

    const cleanUser = targetAdminUsername.replace('@', '').toLowerCase();
    if (cleanUser === 'ropogku') {
      return res.status(400).json({ error: 'Нельзя удалить главного администратора' });
    }
    await db.execute({
      sql: `DELETE FROM admins WHERE LOWER(username) = ?`,
      args: [cleanUser]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
