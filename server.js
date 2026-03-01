/**
 * Group Peace — Express Server for Render deployment
 * Drop-in replacement for /.netlify/functions/api
 *
 * Storage: Local JSON files in ./data/  (persists across restarts on Render disk)
 *   - profiles.json
 *   - messages.json
 *   - blogs.json
 *   - gallery.json
 *   - dm_queue_{user}.json
 *   - media/  (raw base64 data files)
 *
 * Environment variables:
 *   GROUPPACE_JWT_SECRET   — JWT signing secret (required in production)
 *   PORT                   — HTTP port (default 3000)
 *
 * Usage:
 *   npm install express jsonwebtoken bcryptjs
 *   node server.js
 *
 * Render start command:  node server.js
 * Render build command:  npm install
 */

'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');

// ─── Config ───────────────────────────────────────────────────────────────────
const JWT_SECRET   = process.env.GROUPPACE_JWT_SECRET || 'dev-secret-change-me';
const PORT         = process.env.PORT || 3000;
const DATA_DIR     = path.join(__dirname, 'data');
const MEDIA_DIR    = path.join(DATA_DIR, 'media');
const MAX_MESSAGES = 500;
const MAX_QUEUE    = 200;

// Ensure data directories exist
fs.mkdirSync(DATA_DIR,  { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ─── Storage helpers (sync file-based, mirrors Netlify Blobs API) ─────────────
function dataPath(key) {
    // dm_queue_{user} and media_{id} get their own files
    const safe = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(DATA_DIR, safe);
}

function getBlob(key, fallback) {
    try {
        const raw = fs.readFileSync(dataPath(key), 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

function setBlob(key, value) {
    fs.writeFileSync(dataPath(key), JSON.stringify(value));
}

function getMediaBlob(id) {
    try { return fs.readFileSync(path.join(MEDIA_DIR, id), 'utf8'); }
    catch (_) { return null; }
}

function setMediaBlob(id, dataUrl) {
    fs.writeFileSync(path.join(MEDIA_DIR, id), dataUrl);
}

function deleteMediaBlob(id) {
    try { fs.unlinkSync(path.join(MEDIA_DIR, id)); } catch (_) {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitize(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function verifyToken(authHeader) {
    const token = (authHeader || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    try { return jwt.verify(token, JWT_SECRET); }
    catch (_) { return null; }
}

function requireAuth(req) {
    const user = verifyToken(req.headers['authorization']);
    if (!user) throw { status: 401, error: 'Unauthorized' };
    return user;
}

function requireApp(req) {
    const ct = req.headers['x-client-type'];
    if (ct !== 'android') throw { status: 403, error: 'This feature is only available in the mobile app.' };
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// POST /api/auth/register
function register(req, res) {
    const { username, password } = req.body || {};
    if (!username || !password)       return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3)          return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6)          return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const clean = username.replace(/[^a-zA-Z0-9_-]/g, '');
    if (clean !== username)            return res.status(400).json({ error: 'Username: letters, numbers, _ and - only' });

    const profiles = getBlob('profiles.json', {});
    if (profiles[clean])               return res.status(400).json({ error: 'Username already taken' });

    bcrypt.hash(password, 12).then(hash => {
        profiles[clean] = {
            passwordHash: hash,
            displayName:  clean,
            bio:          '',
            avatarUrl:    '',
            aiApiKey:     null,
            created:      new Date().toISOString(),
            lastLogin:    new Date().toISOString(),
        };
        setBlob('profiles.json', profiles);
        const token = jwt.sign({ username: clean }, JWT_SECRET, { expiresIn: '30d' });
        res.status(201).json({ message: 'Account created', token, username: clean });
    }).catch(() => res.status(500).json({ error: 'Internal server error' }));
}

// POST /api/auth/login
function login(req, res) {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const profiles = getBlob('profiles.json', {});
    const profile  = profiles[username];
    if (!profile) return res.status(400).json({ error: 'Invalid credentials' });

    bcrypt.compare(password, profile.passwordHash).then(ok => {
        if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
        profiles[username].lastLogin = new Date().toISOString();
        setBlob('profiles.json', profiles);
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ message: 'Login successful', token, username });
    }).catch(() => res.status(500).json({ error: 'Internal server error' }));
}

// GET /api/profile/:username
function getProfile(req, res) {
    const profiles = getBlob('profiles.json', {});
    const p = profiles[req.params.username];
    if (!p) return res.status(404).json({ error: 'User not found' });
    res.json({
        username:    req.params.username,
        displayName: p.displayName || req.params.username,
        bio:         p.bio         || '',
        avatarUrl:   p.avatarUrl   || '',
        created:     p.created,
    });
}

// PUT /api/profile
function updateProfile(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const { displayName, bio, avatarUrl } = req.body || {};
    const profiles = getBlob('profiles.json', {});
    const p = profiles[user.username];
    if (!p) return res.status(404).json({ error: 'User not found' });

    if (displayName !== undefined) {
        if (displayName.length > 40) return res.status(400).json({ error: 'Display name too long' });
        p.displayName = sanitize(displayName.trim());
    }
    if (bio !== undefined) {
        if (bio.length > 300) return res.status(400).json({ error: 'Bio too long (max 300 chars)' });
        p.bio = sanitize(bio.trim());
    }
    if (avatarUrl !== undefined) {
        const isHttpUrl = /^https?:\/\/.+/.test(avatarUrl);
        const isDataUrl = /^data:image\/(png|jpe?g|gif|webp);base64,/.test(avatarUrl);
        if (avatarUrl !== '' && !isHttpUrl && !isDataUrl)
            return res.status(400).json({ error: 'Avatar must be a valid URL or image file' });
        if (isDataUrl && avatarUrl.length > 2 * 1024 * 1024)
            return res.status(400).json({ error: 'Avatar image too large (max ~1.5 MB)' });
        p.avatarUrl = avatarUrl.trim();
    }
    setBlob('profiles.json', profiles);
    res.json({ message: 'Profile updated', displayName: p.displayName, bio: p.bio, avatarUrl: p.avatarUrl });
}

// PUT /api/profile/apikey  [app-only]
function setApiKey(req, res) {
    try { requireApp(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const { apiKey, provider } = req.body || {};
    const profiles = getBlob('profiles.json', {});
    const p = profiles[user.username];
    if (!p) return res.status(404).json({ error: 'User not found' });

    const field = provider === 'anthropic' ? 'anthropicKey' : provider === 'google' ? 'googleKey' : 'aiApiKey';
    p[field] = (apiKey || '').trim() || null;
    setBlob('profiles.json', profiles);
    res.json({ message: p[field] ? 'API key saved' : 'API key removed' });
}

// GET /api/profile/apikey/status  [app-only]
function getApiKeyStatus(req, res) {
    try { requireApp(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const profiles = getBlob('profiles.json', {});
    const p = profiles[user.username];
    if (!p) return res.status(404).json({ error: 'User not found' });
    res.json({ hasKey: !!(p.aiApiKey || p.anthropicKey || p.googleKey) });
}

// GET /api/users
function getUsers(req, res) {
    const profiles = getBlob('profiles.json', {});
    const list = Object.entries(profiles).map(([username, p]) => ({
        username,
        displayName: p.displayName || username,
        avatarUrl:   p.avatarUrl   || '',
    }));
    res.json(list);
}

// GET /api/messages
function getMessages(req, res) {
    const messages = getBlob('messages.json', []);
    res.json(messages.slice(-100));
}

// POST /api/messages  [auth]
function postMessage(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const { message } = req.body || {};
    if (!message?.trim())      return res.status(400).json({ error: 'Message required' });
    if (message.length > 1000) return res.status(400).json({ error: 'Message too long' });

    const messages = getBlob('messages.json', []);
    const profiles = getBlob('profiles.json', {});
    const p = profiles[user.username] || {};
    const newMsg = {
        id:          uid(),
        user:        user.username,
        displayName: p.displayName || user.username,
        avatarUrl:   p.avatarUrl   || '',
        message:     message.trim(),
        timestamp:   new Date().toISOString(),
    };
    messages.push(newMsg);
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
    setBlob('messages.json', messages);
    res.status(201).json(newMsg);
}

// GET /api/blogs
function getBlogs(req, res) {
    const tag   = req.query.tag || null;
    const blogs = getBlob('blogs.json', []);
    const result = tag
        ? blogs.filter(b => b.tags?.some(t => t.toLowerCase() === tag.toLowerCase()))
        : blogs;
    const list = [...result]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(b => ({
            id:            b.id,
            title:         b.title,
            author:        b.author,
            displayName:   b.displayName,
            avatarUrl:     b.avatarUrl,
            tags:          b.tags,
            createdAt:     b.createdAt,
            likesCount:    b.likes?.length    || 0,
            commentsCount: b.comments?.length || 0,
            preview:       (b.body || '').substr(0, 200),
        }));
    res.json(list);
}

// GET /api/blogs/:id
function getBlog(req, res) {
    const blogs = getBlob('blogs.json', []);
    const b = blogs.find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'Post not found' });
    res.json(b);
}

// POST /api/blogs  [auth]
function createBlog(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const { title, body, tags } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
    if (!body?.trim())  return res.status(400).json({ error: 'Body required' });
    if (title.length > 120)   return res.status(400).json({ error: 'Title too long' });
    if (body.length > 20000)  return res.status(400).json({ error: 'Body too long' });

    const profiles = getBlob('profiles.json', {});
    const p = profiles[user.username] || {};
    const cleanTags = Array.isArray(tags)
        ? tags.map(t => sanitize(String(t).trim().toLowerCase())).filter(t => t && t.length <= 30).slice(0, 10)
        : [];

    const blogs = getBlob('blogs.json', []);
    const newPost = {
        id:          uid(),
        title:       sanitize(title.trim()),
        body:        body.trim(),
        author:      user.username,
        displayName: p.displayName || user.username,
        avatarUrl:   p.avatarUrl   || '',
        tags:        cleanTags,
        likes:       [],
        comments:    [],
        createdAt:   new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
    };
    blogs.push(newPost);
    setBlob('blogs.json', blogs);
    res.status(201).json(newPost);
}

// PUT /api/blogs/:id  [auth, own]
function updateBlog(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const blogs = getBlob('blogs.json', []);
    const idx   = blogs.findIndex(b => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Post not found' });
    if (blogs[idx].author !== user.username) return res.status(403).json({ error: 'Not your post' });

    const { title, body, tags } = req.body || {};
    if (title !== undefined) {
        if (title.length > 120) return res.status(400).json({ error: 'Title too long' });
        blogs[idx].title = sanitize(title.trim());
    }
    if (body !== undefined) {
        if (body.length > 20000) return res.status(400).json({ error: 'Body too long' });
        blogs[idx].body = body.trim();
    }
    if (Array.isArray(tags)) {
        blogs[idx].tags = tags.map(t => sanitize(String(t).trim().toLowerCase())).filter(t => t && t.length <= 30).slice(0, 10);
    }
    blogs[idx].updatedAt = new Date().toISOString();
    setBlob('blogs.json', blogs);
    res.json(blogs[idx]);
}

// DELETE /api/blogs/:id  [auth, own]
function deleteBlog(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const blogs = getBlob('blogs.json', []);
    const idx   = blogs.findIndex(b => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Post not found' });
    if (blogs[idx].author !== user.username) return res.status(403).json({ error: 'Not your post' });
    blogs.splice(idx, 1);
    setBlob('blogs.json', blogs);
    res.json({ message: 'Deleted' });
}

// POST /api/blogs/:id/like  [auth]
function likeBlog(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const blogs = getBlob('blogs.json', []);
    const b     = blogs.find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'Post not found' });
    const i = b.likes.indexOf(user.username);
    if (i === -1) b.likes.push(user.username);
    else          b.likes.splice(i, 1);
    setBlob('blogs.json', blogs);
    res.json({ liked: i === -1, count: b.likes.length });
}

// POST /api/blogs/:id/comments  [auth]
function addComment(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const { text } = req.body || {};
    if (!text?.trim())   return res.status(400).json({ error: 'Comment text required' });
    if (text.length > 500) return res.status(400).json({ error: 'Comment too long' });

    const blogs = getBlob('blogs.json', []);
    const b = blogs.find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'Post not found' });

    const profiles = getBlob('profiles.json', {});
    const p = profiles[user.username] || {};
    const comment = {
        id:          uid(),
        author:      user.username,
        displayName: p.displayName || user.username,
        avatarUrl:   p.avatarUrl   || '',
        text:        sanitize(text.trim()),
        createdAt:   new Date().toISOString(),
    };
    b.comments.push(comment);
    setBlob('blogs.json', blogs);
    res.status(201).json(comment);
}

// DELETE /api/blogs/:id/comments/:cid  [auth, own]
function deleteComment(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const blogs = getBlob('blogs.json', []);
    const b     = blogs.find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'Post not found' });
    const ci = b.comments.findIndex(c => c.id === req.params.cid);
    if (ci === -1) return res.status(404).json({ error: 'Comment not found' });
    if (b.comments[ci].author !== user.username) return res.status(403).json({ error: 'Not your comment' });
    b.comments.splice(ci, 1);
    setBlob('blogs.json', blogs);
    res.json({ message: 'Deleted' });
}

// GET /api/gallery
function getGallery(req, res) {
    const gallery = getBlob('gallery.json', []);
    res.json([...gallery].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
}

// POST /api/gallery/upload  [auth]
function uploadGallery(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const { filename, type, dataUrl, size } = req.body || {};
    if (!dataUrl)                return res.status(400).json({ error: 'No file data' });
    if (size > 4 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 4 MB)' });

    const id = uid();
    setMediaBlob(id, dataUrl);

    const gallery  = getBlob('gallery.json', []);
    const profiles = getBlob('profiles.json', {});
    const p = profiles[user.username] || {};
    const item = {
        id,
        filename:    filename || 'upload',
        type:        type     || 'image',
        size:        size     || 0,
        uploader:    user.username,
        displayName: p.displayName || user.username,
        timestamp:   new Date().toISOString(),
        url:         `/api/gallery/media/${id}`,
    };
    gallery.push(item);
    if (gallery.length > 300) gallery.splice(0, gallery.length - 300);
    setBlob('gallery.json', gallery);
    res.status(201).json({ message: 'Uploaded', item });
}

// GET /api/gallery/media/:id
function serveMedia(req, res) {
    const dataUrl = getMediaBlob(req.params.id);
    if (!dataUrl) return res.status(404).json({ error: 'Not found' });
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) return res.status(500).json({ error: 'Corrupt media' });
    const buf = Buffer.from(match[2], 'base64');
    res.set('Content-Type', match[1]);
    res.set('Cache-Control', 'public, max-age=31536000');
    res.send(buf);
}

// DELETE /api/gallery/:id  [auth, own]
function deleteGalleryItem(req, res) {
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const gallery = getBlob('gallery.json', []);
    const idx     = gallery.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    if (gallery[idx].uploader !== user.username) return res.status(403).json({ error: 'Not your item' });
    gallery.splice(idx, 1);
    setBlob('gallery.json', gallery);
    deleteMediaBlob(req.params.id);
    res.json({ message: 'Deleted' });
}

// POST /api/dm/send  [auth, app-only]
function dmSend(req, res) {
    try { requireApp(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const { to, message } = req.body || {};
    if (!to || !message?.trim()) return res.status(400).json({ error: 'Recipient and message required' });
    if (to === user.username)    return res.status(400).json({ error: 'Cannot message yourself' });
    if (message.length > 1000)  return res.status(400).json({ error: 'Message too long' });

    const profiles = getBlob('profiles.json', {});
    if (!profiles[to]) return res.status(404).json({ error: 'Recipient not found' });

    const queueKey = `dm_queue_${to}.json`;
    const queue    = getBlob(queueKey, []);
    const msg = { id: uid(), from: user.username, to, message: message.trim(), timestamp: new Date().toISOString() };
    queue.push(msg);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    setBlob(queueKey, queue);
    res.status(201).json({ message: 'Sent', id: msg.id });
}

// GET /api/dm/poll  [auth, app-only]
function dmPoll(req, res) {
    try { requireApp(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }
    let user;
    try { user = requireAuth(req); } catch (e) { return res.status(e.status).json({ error: e.error }); }

    const queueKey = `dm_queue_${user.username}.json`;
    const queue    = getBlob(queueKey, []);
    if (queue.length > 0) setBlob(queueKey, []); // drain
    res.json(queue);
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

// CORS — allow all origins (mirrors Netlify function behaviour)
app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin',  '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Client-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    next();
});

// Body parsing — increase limit to handle base64 image uploads
app.use(express.json({ limit: '10mb' }));

// Serve static files (index.html, home.html, app.html, APK, etc.)
// Place all your HTML/APK files in a  public/  folder next to server.js
app.use(express.static(path.join(__dirname, 'public')));

// ─── API routes ───────────────────────────────────────────────────────────────
const r = express.Router();

// Debug
r.get('/debug', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Auth
r.post('/auth/register', register);
r.post('/auth/login',    login);

// Profile — specific routes BEFORE :username wildcard
r.get ('/profile/apikey/status', getApiKeyStatus);
r.put ('/profile/apikey',        setApiKey);
r.put ('/profile',               updateProfile);
r.get ('/profile/:username',     getProfile);

// Users
r.get('/users', getUsers);

// Messages
r.get ('/messages', getMessages);
r.post('/messages', postMessage);

// Blogs
r.get   ('/blogs',                        getBlogs);
r.post  ('/blogs',                        createBlog);
r.get   ('/blogs/:id',                    getBlog);
r.put   ('/blogs/:id',                    updateBlog);
r.delete('/blogs/:id',                    deleteBlog);
r.post  ('/blogs/:id/like',               likeBlog);
r.post  ('/blogs/:id/comments',           addComment);
r.delete('/blogs/:id/comments/:cid',      deleteComment);

// Gallery
r.get   ('/gallery',            getGallery);
r.post  ('/gallery/upload',     uploadGallery);
r.get   ('/gallery/media/:id',  serveMedia);
r.delete('/gallery/:id',        deleteGalleryItem);

// DM
r.post('/dm/send', dmSend);
r.get ('/dm/poll', dmPoll);

// Mount under /api  AND  /.netlify/functions/api  so both old and new clients work
app.use('/api',                          r);
app.use('/.netlify/functions/api',       r);

// Catch-all: serve index.html for any unmatched route (SPA fallback)
app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`Group Peace server running on port ${PORT}`);
    console.log(`  API: http://localhost:${PORT}/api`);
    console.log(`  Data directory: ${DATA_DIR}`);
});
