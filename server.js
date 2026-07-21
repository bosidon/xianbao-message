require('dotenv').config({ path: '/var/www/.env' });
const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { verifyToken, extractToken } = require('/var/www/auth-verify');
const app = express();
const PORT = process.env.MESSAGE_PORT || 3060;
const initSqlJs = require('sql.js');
const dbPath = path.join(__dirname, 'messages.db');
let db = null;

async function initDb() {
  const SQL = await initSqlJs();
  try { const buf = fs.readFileSync(dbPath); db = new SQL.Database(buf); }
  catch { db = new SQL.Database(); }
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, username TEXT DEFAULT '', nickname TEXT DEFAULT '', avatar_url TEXT DEFAULT '', title TEXT DEFAULT '', content TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'question', reply_count INTEGER DEFAULT 0, like_count INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','localtime')), updated_at DATETIME DEFAULT (datetime('now','localtime')))");
  db.run("CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, username TEXT DEFAULT '', nickname TEXT DEFAULT '', avatar_url TEXT DEFAULT '', parent_id INTEGER DEFAULT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now','localtime')))");
  db.run("CREATE TABLE IF NOT EXISTS likes (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at DATETIME DEFAULT (datetime('now','localtime')), UNIQUE(message_id, user_id))");
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_cat ON messages(category)");
  db.run("CREATE INDEX IF NOT EXISTS idx_replies_msg ON replies(message_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_likes_msg ON likes(message_id)");
  // Migration: add like_count to existing tables
  try { db.run("ALTER TABLE messages ADD COLUMN like_count INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0"); } catch(e) {}
  saveDb(); console.log('DB ready');
}
function saveDb() { const data = db.export(); fs.writeFileSync(dbPath, Buffer.from(data)); }

app.use(express.json({limit:'10mb'}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'frontend'), { maxAge: 0, etag: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const crypto = require('crypto');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.post('/api/upload', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  const { image } = req.body;
  if (!image) return res.json({ success: false, error: '请选择图片' });
  try {
    const match = image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.json({ success: false, error: '图片格式无效' });
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    if (!['jpg','png','gif','webp'].includes(ext)) return res.json({ success: false, error: '仅支持 jpg/png/gif/webp' });
    const buf = Buffer.from(match[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.json({ success: false, error: '图片不能超过5MB' });
    const name = Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(uploadsDir, name), buf);
    res.json({ success: true, url: '/message/uploads/' + name });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

function getReqUser(req) {
  const t = extractToken(req);
  if (!t) return null;
  return verifyToken(t);
}

function getLikedMap(userId) {
  if (!userId) return {};
  try {
    const rows = db.exec('SELECT message_id FROM likes WHERE user_id = ?', [userId]);
    if (!rows || !rows[0]) return {};
    const map = {};
    rows[0].values.forEach(r => { map[r[0]] = true; });
    return map;
  } catch(e) { return {}; }
}

app.get('/api/messages', async (req, res) => {
  const category = req.query.category || '';
  const sort = req.query.sort === 'hot' ? 'reply_count DESC' : 'created_at DESC';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  let where = ''; const params = [];
  if (category && ['question','reflection'].includes(category)) { where = 'WHERE category = ?'; params.push(category); }
  const u = await getReqUser(req);
  if (req.query.mine === '1') {
    if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
    if (where) { where += ' AND user_id = ?'; } else { where = 'WHERE user_id = ?'; }
    params.push(u.user.id);
  }
  try {
    const total = db.exec('SELECT COUNT(*) as c FROM messages ' + where, params)[0];
    const rows = db.exec('SELECT id, user_id, username, nickname, avatar_url, title, content, category, reply_count, like_count, pinned, created_at, updated_at FROM messages ' + where + ' ORDER BY pinned DESC, ' + sort + ' LIMIT ? OFFSET ?', params.concat([limit, offset]));
    const likedMap = u && u.success ? getLikedMap(u.user.id) : {};
    const messages = rows && rows[0] ? rows[0].values.map(r => ({ id: r[0], user_id: r[1], username: r[2], nickname: r[3], avatar_url: r[4], title: r[5], content: (r[6]||'').substring(0,200), category: r[7], reply_count: r[8], like_count: r[9]||0, pinned: r[10]||0, created_at: r[11], updated_at: r[12], liked: !!likedMap[r[0]] })) : [];
    res.json({ success: true, data: { messages, total: total ? total.values[0][0] : 0, page, limit } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/messages/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 1) return res.json({ success: false, error: '请输入搜索关键词' });
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  try {
    const like = '%' + q.replace(/%/g,'%%') + '%';
    const total = db.exec('SELECT COUNT(*) as c FROM messages WHERE title LIKE ? OR content LIKE ?', [like, like])[0];
    const rows = db.exec('SELECT id, user_id, username, nickname, avatar_url, title, content, category, reply_count, like_count, pinned, created_at, updated_at FROM messages WHERE title LIKE ? OR content LIKE ? ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?', [like, like, limit, offset]);
    const u = getReqUser(req);
    const likedMap = u && u.success ? getLikedMap(u.user.id) : {};
    const messages = rows && rows[0] ? rows[0].values.map(r => ({ id: r[0], user_id: r[1], username: r[2], nickname: r[3], avatar_url: r[4], title: r[5], content: (r[6]||'').substring(0,200), category: r[7], reply_count: r[8], like_count: r[9]||0, pinned: r[10]||0, created_at: r[11], updated_at: r[12], liked: !!likedMap[r[0]] })) : [];
    res.json({ success: true, data: { messages, total: total ? total.values[0][0] : 0, page, limit, query: q } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/messages', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  const user = u.user; const { title, content, category } = req.body;
  if (!content || content.length < 2) return res.json({ success: false, error: '内容至少2字' });
  if (!['question','reflection'].includes(category)) return res.json({ success: false, error: '分类无效' });
  try {
    db.run('INSERT INTO messages (user_id, username, nickname, avatar_url, title, content, category) VALUES (?,?,?,?,?,?,?)',
      [user.id, user.username||'', user.nickname||user.username||'', user.avatar_url||'', title||'', content, category]);
    saveDb(); res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/messages/:id', (req, res) => {
  try {
    const msg = db.exec('SELECT id, user_id, username, nickname, avatar_url, title, content, category, reply_count, like_count, pinned, created_at, updated_at FROM messages WHERE id = ?', [req.params.id]);
    if (!msg || !msg[0]) return res.json({ success: false, error: '不存在' });
    const m = msg[0].values[0];
    const u = getReqUser(req);
    let liked = false;
    if (u && u.success) {
      const r = db.exec('SELECT COUNT(*) as c FROM likes WHERE message_id = ? AND user_id = ?', [req.params.id, u.user.id]);
      liked = r && r[0] && r[0].values[0][0] > 0;
    }
    const message = { id: m[0], user_id: m[1], username: m[2], nickname: m[3], avatar_url: m[4], title: m[5], content: m[6], category: m[7], reply_count: m[8], like_count: m[9]||0, pinned: m[10]||0, created_at: m[11], updated_at: m[12], liked };
    const reps = db.exec('SELECT id, user_id, username, nickname, avatar_url, parent_id, content, created_at FROM replies WHERE message_id = ? ORDER BY created_at ASC', [req.params.id]);
    const replies = reps && reps[0] ? reps[0].values.map(r => ({ id: r[0], user_id: r[1], username: r[2], nickname: r[3], avatar_url: r[4], parent_id: r[5], content: r[6], created_at: r[7] })) : [];
    res.json({ success: true, data: { message, replies } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.put('/api/messages/:id', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  const user = u.user; const { title, content } = req.body;
  if (!content || content.length < 2) return res.json({ success: false, error: '内容至少2字' });
  try {
    const msg = db.exec('SELECT user_id FROM messages WHERE id = ?', [req.params.id]);
    if (!msg || !msg[0]) return res.json({ success: false, error: '不存在' });
    if (msg[0].values[0][0] !== user.id) return res.json({ success: false, error: '无权编辑' });
    db.run('UPDATE messages SET title = ?, content = ?, updated_at = datetime("now","localtime") WHERE id = ?', [title||'', content, req.params.id]);
    saveDb(); res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/messages/:id/reply', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  const user = u.user; const { content } = req.body;
  if (!content) return res.json({ success: false, error: '请输入内容' });
  try {
    db.run('INSERT INTO replies (message_id, user_id, username, nickname, avatar_url, parent_id, content) VALUES (?,?,?,?,?,?,?)',
      [req.params.id, user.id, user.username||'', user.nickname||user.username||'', user.avatar_url||'', null, content]);
    db.run('UPDATE messages SET reply_count = reply_count + 1 WHERE id = ?', [req.params.id]);
    saveDb(); res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/messages/:id/like', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  try {
    const existing = db.exec('SELECT id FROM likes WHERE message_id = ? AND user_id = ?', [req.params.id, u.user.id]);
    if (existing && existing[0]) {
      db.run('DELETE FROM likes WHERE message_id = ? AND user_id = ?', [req.params.id, u.user.id]);
      db.run('UPDATE messages SET like_count = MAX(0, like_count - 1) WHERE id = ?', [req.params.id]);
      saveDb();
      const cnt = db.exec('SELECT like_count FROM messages WHERE id = ?', [req.params.id]);
      res.json({ success: true, liked: false, like_count: (cnt && cnt[0]) ? cnt[0].values[0][0] : 0 });
    } else {
      db.run('INSERT INTO likes (message_id, user_id) VALUES (?,?)', [req.params.id, u.user.id]);
      db.run('UPDATE messages SET like_count = like_count + 1 WHERE id = ?', [req.params.id]);
      saveDb();
      const cnt = db.exec('SELECT like_count FROM messages WHERE id = ?', [req.params.id]);
      res.json({ success: true, liked: true, like_count: (cnt && cnt[0]) ? cnt[0].values[0][0] : 0 });
    }
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/messages/:id/pin', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  if (u.user.role !== 'admin') return res.json({ success: false, error: '仅管理员可操作' });
  try {
    const msg = db.exec('SELECT pinned FROM messages WHERE id = ?', [req.params.id]);
    if (!msg || !msg[0]) return res.json({ success: false, error: '不存在' });
    var curPinned = msg[0].values[0][0] || 0;
    var newPinned = curPinned ? 0 : 1;
    db.run('UPDATE messages SET pinned = ? WHERE id = ?', [newPinned, req.params.id]);
    saveDb();
    res.json({ success: true, pinned: newPinned === 1 });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/messages/:id', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  try {
    const msg = db.exec('SELECT user_id FROM messages WHERE id = ?', [req.params.id]);
    if (!msg || !msg[0]) return res.json({ success: false, error: '不存在' });
    if (msg[0].values[0][0] !== u.user.id && u.user.role !== 'admin') return res.json({ success: false, error: '无权删除' });
    db.run('DELETE FROM messages WHERE id = ?', [req.params.id]);
    db.run('DELETE FROM replies WHERE message_id = ?', [req.params.id]);
    db.run('DELETE FROM likes WHERE message_id = ?', [req.params.id]);
    saveDb(); res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

initDb().then(() => app.listen(PORT, () => console.log('messages on :' + PORT)));
