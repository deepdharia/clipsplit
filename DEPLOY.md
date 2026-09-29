# ClipSplit — Deploy Guide (free, ~30 minutes)

Everything is static. No server, no build step, no env vars. The folder deploys as-is.

## What was built

`~/workspace/video-splitter/` — a complete static site:

| File | Purpose |
|---|---|
| `index.html` | Tool UI + SEO content (hero, how-it-works, features, use cases, FAQ), JSON-LD (`WebApplication`, `FAQPage`, `BreadcrumbList`), OG/Twitter tags, 3 AdSense placeholder slots |
| `app.js` | The whole splitter engine (see "How splitting works") |
| `styles.css` | Mobile-first styles |
| `favicon.svg`, `og-cover.png` | Brand assets |
| `sitemap.xml`, `robots.txt` | SEO plumbing (domain placeholder inside — replace!) |

### How splitting works (2 engines)

- **Original format → lossless fast path.** Packets flow from `EncodedPacketSink` straight into `EncodedVideoPacketSource` / `EncodedAudioPacketSource` and out through `Mp4OutputFormat` — zero re-encoding, bit-for-bit identical quality, seconds per clip. Cuts snap to the nearest verified keyframe at/before each cut point (segments tile edge-to-edge on snapped boundaries, so nothing overlaps or goes missing). The UI always shows each clip's *actual* start time.
- **9:16 crop / 9:16 blur-bg / 1:1 → re-encode path.** Frames decode via `VideoSampleSink`, get composited on canvas (rotation baked in, even dimensions enforced), and re-encoded to H.264 with `CanvasSource` at High/Medium/Low `Quality`. **Audio is always stream-copied untouched**, even here.
- Engine: **Mediabunny 1.61.0** (pinned in `app.js` → `MB_URL`), lazy-loaded from jsDelivr only when a file is dropped. ZIP via **JSZip 3.10.2** (pinned → `JSZIP_URL`), lazy-loaded only when "Download all" is clicked.
- Privacy: after page load, **zero network** except those two CDN fetches. Video bytes never leave the device.

## Step 1 — Pick a domain

Keyword-rich ideas (check availability at **Porkbun** or **Cloudflare Registrar** — both sell at wholesale, no upsells):

1. `clipsplit.in` — brand match, .in is cheap (~₹500/yr), good since your audience/ops are India-based
2. `freesplitvideo.com` — exact-match keywords ("free split video")
3. `splitvideoonline.com` — exact-match ("split video online")
4. `longvideotoshorts.com` — use-case keyword (long video → Shorts), great for content/SEO angle

⚠️ `.com` squatting is heavy in the tool niche — most clean keyword .coms are taken or parked at $2k+. Strategy: search the **.com first**; if taken/expensive, take the **.in / .co / .app** of your favorite instead of overpaying. A brandable domain + good content beats a mediocre exact-match .com. Avoid hyphens.

**After buying:** replace the placeholder domain everywhere (it currently says `clipsplit.app`):

- `index.html` → `<link rel="canonical">`, `og:*` / `twitter:*` tags, all three JSON-LD `url`/`item` fields
- `sitemap.xml` → `<loc>`
- `robots.txt` → `Sitemap:` line

## Step 2 — Push to GitHub

```bash
cd ~/workspace/video-splitter
git init -b main
git add -A
git commit -m "ClipSplit v1"
gh repo create clipsplit --public --source=. --push
```

(No `gh`? Create the repo at github.com/new and `git remote add origin <url>` + `git push -u origin main`.)

## Step 3 — Deploy (pick one; both free)

**Vercel (easiest):**
1. Go to `vercel.com/new` → *Import* your `clipsplit` repo.
2. Framework Preset → **Other**. No build command, no output dir (it's static).
3. *Deploy* → you get `https://clipsplit.vercel.app` live in ~30s.
4. Project → **Settings → Domains** → add your domain → Vercel shows the DNS records → add them at your registrar (A / CNAME as shown). HTTPS is automatic.

**Cloudflare Pages (alternative):**
1. `dash.cloudflare.com` → *Workers & Pages* → *Create* → *Pages* → *Connect to Git* → pick repo.
2. Build settings: framework **None**, build command empty, output dir `/`. Deploy.
3. *Custom domains* tab → add domain (if the domain is already on Cloudflare, it's one click + auto HTTPS).

## Step 4 — Google Search Console

1. `search.google.com/search-console` → *Add property* → your domain → verify via **DNS TXT** (registrar DNS panel).
2. *Sitemaps* → submit `https://YOURDOMAIN/sitemap.xml`.
3. *URL Inspection* → request indexing for `/`. Indexing typically takes days–weeks; the FAQ + HowTo-style content is what earns rich results.

## Step 5 — AdSense (after approval)

1. Apply at `adsense.google.com` with the live domain (needs real content + some traffic; the FAQ section helps).
2. Once approved, paste your AdSense `<script>` into `<head>` of `index.html`.
3. Replace the 3 placeholder comments with real ad units:
   - `ADSENSE_SLOT_ID_1` — display ad **below the tool**
   - `ADSENSE_SLOT_ID_2` — in-article ad **between content and FAQ**
   - `ADSENSE_SLOT_ID_3` — display ad **above the footer**
   
   They're placed clear of buttons/click targets (policy-safe). Keep the `data-ad-format` hints.

## Step 6 — The 10-minute manual test script

Do this once on desktop Chrome/Edge after deploy (this environment has no browser, so this run is **your** verification gate):

1. **Load:** open the site → drop a ~5-min 1080p H.264 MP4 → engine loads, preview + timeline appear, file meta looks right.
2. **Fast path:** mode *Every X sec* → 30s → Split → expect ~10 clips. Cards show thumbnails, sizes, and start times (e.g. `0:29.9` — keyframe snap). Download clip 1 → plays in VLC *and* on your phone, ~30s, no watermark, visually identical quality.
3. **Snap honesty:** confirm the snap note under "Your clips" is visible.
4. **Custom cuts:** new video (or same) → *Custom cuts* → click timeline twice → 3 clips → each starts at the shown snapped time.
5. **9:16 re-encode:** *Time range* `0:00`–`0:15`, format *9:16 Blur BG* → Split → 1 clip → download → verify it's **720×1280** (VLC → Tools → Codec info) and plays. Repeat once with *9:16 Crop*.
6. **ZIP:** *Equal parts* → 4 → Split → *Download all (.zip)* → unzip → 4 playable MP4s.
7. **Privacy check:** DevTools → Network → during a split, confirm no video bytes are uploaded (only `cdn.jsdelivr.net` fetches). Bonus: go offline after page load → splitting still works.
8. **Mobile:** open the URL on your iPhone → run one quick every-30s split → clips download and play.

## Maintenance notes (build-once friendly)

- **Pinned versions** live in two constants at the top of `app.js`: `MB_URL` (mediabunny@1.61.0), `JSZIP_URL` (jszip@3.10.2). To upgrade, bump + re-run the test script.
- No dependencies to install, no build to break. If jsDelivr ever has issues, the same files exist on `unpkg.com`.
- Known v1 limitations (all disclosed in UI/FAQ where relevant): subtitle tracks are dropped from clips; fast-path cuts snap to keyframes; re-encode needs a WebCodecs-capable browser (graceful error otherwise); very large files are bounded by device RAM.

## Verified vs not-verified (read this)

**Verified 2026-09-29 from primary sources:** Mediabunny 1.61.0 exports and signatures (`Input`/`BlobSource`/`ALL_FORMATS`, `EncodedPacketSink.packets()` decode-order iteration, `getKeyPacket` + `verifyKeyPackets`, `EncodedVideoPacketSource`/`EncodedAudioPacketSource` decode-order-in/presentation-timestamps-out, `Output`/`Mp4OutputFormat({fastStart:'in-memory'})`/`BufferTarget.buffer`, `VideoSampleSink.samples()` + `sample.draw/close`, `CanvasSource.add()`, `new Quality('high')`, `getDecoderConfig()`, `canDecode()`), all read from the package's own `.d.ts` on jsDelivr; JSZip 3.10.2 on jsDelivr; `node --check` clean; JSON-LD parses; every DOM id referenced in JS exists in HTML; FAQ copy matches JSON-LD verbatim.

**NOT verified (no browser in this environment):** actual end-to-end splitting of a real video file, clip playability, thumbnail rendering, ZIP contents, and mobile behavior. The test script above is the mitigation — run it before sharing the link publicly.
