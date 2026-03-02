# 🕊️ Group Peace

A free, private, ad-free local community network. Group chat, community blogs, shared gallery, private messaging and an AI assistant — all in one app.

## Live Demo
Will update soon
## Features

- 💬 **Group Chat** — real-time messages for everyone on the network
- 🔒 **Private Messages** — 1-on-1 DMs stored locally on your device
- 📝 **Community Blog** — long-form posts with tags, likes and comments
- 📸 **Gallery** — upload and share photos and videos
- 🤖 **AI Assistant** — bring your own OpenAI, Anthropic or Google key
- 👤 **Profiles** — display name, bio and avatar

## Stack

- **Frontend** — plain HTML/CSS/JS (no framework)
- **Backend** — Node.js + Express
- **Storage** — local JSON files (no database required)
- **Auth** — JWT + bcrypt

## Deployment (Render)

1. Fork or clone this repo and push to GitHub
2. Create a new **Web Service** on [render.com](https://render.com) and connect your repo
3. Set the following:

| Setting | Value |
|---|---|
| Build command | `npm install` |
| Start command | `node server.js` |
| Environment variable | `GROUPPACE_JWT_SECRET` = any long random string |

4. Deploy — your app will be live at `https://your-app.onrender.com`

> **Note:** Render's free tier resets the disk on every redeploy, so data will be lost. Upgrade to a paid plan and add a persistent disk mounted at `/data` if you need data to survive redeploys.

## Local Development

```bash
git clone https://github.com/yourusername/group-peace
cd group-peace
npm install
GROUPPACE_JWT_SECRET=dev-secret node server.js
```

Then open `http://localhost:3000`

## Project Structure

```
group-peace/
├── server.js        # Express server + all API routes
├── package.json
├── .gitignore
└── public/
    ├── index.html   # Landing page
    ├── home.html    # Web app
    └── app.html     # Mobile-optimised app
```

## Android APK

An Android APK is available for the full experience (private messaging, AI assistant, offline-first storage). Download it from the landing page or add `group-peace.apk` to the `public/` folder.

## License

MIT
