# gTabs — AI Tab Organizer for Chrome

<div align="center">
  <br/>

  **Your tabs are a mess. One click fixes that.**

  gTabs uses any LLM to intelligently organize your Chrome tabs into color-coded groups.
  It learns from your behavior, remembers your corrections, and gets smarter over time.

  <br/>

  [Star on GitHub](https://github.com/vaddisrinivas/gtabs) · [Install](https://github.com/vaddisrinivas/gtabs/releases) · [Report Issue](https://github.com/vaddisrinivas/gtabs/issues)

  <br/>
</div>

![gTabs demo](store-assets/demo-v04.gif)

---

## What's New in v0.4

**Smart Learning** — gTabs now learns from every interaction. Corrections you make before applying count 3x. Groups you remove are remembered and avoided. Domain affinity is weighted by frequency and recency with a 14-day decay half-life.

**Scheduled Re-org** — Set daily or weekly automatic re-organization at a time you choose. Wake up to perfectly organized tabs.

**Pinned Groups** — Mark groups as permanent so they survive re-organization. Pin "Comms" once, never lose it.

**Group Health** — Drift detection warns when groups become incoherent. Merge/split suggestions appear when groups overlap or grow too large.

**Smarter Routing** — New tabs opened from an existing grouped tab automatically join that group. Path-level affinity means `github.com/myorg` and `github.com/trending` can map to different groups.

---

## Screenshots

| Settings & Providers | Smart Learning | Organized Tabs |
|:---:|:---:|:---:|
| ![Settings](store-assets/screenshot-settings-1280x800.png) | ![Smart Learning](store-assets/screenshot-smart-learning-1280x800.png) | ![Organized](store-assets/screenshot-organized-1280x800.png) |

---

## Features

### Organize

| | |
|---|---|
| **One-click Organize All** | AI groups every tab in your window by topic |
| **Ungrouped Only** | Only touches tabs not already in a group |
| **Suggestion-first UX** | Review, rename, recolor, remove — then apply |
| **Undo** | Instantly restores the previous tab arrangement |
| **Smart Merge** | Pre-assigns tabs to existing groups by title similarity before calling the LLM |

### Learn

| | |
|---|---|
| **Weighted Affinity** | Tracks how often each domain is placed in each group, decays stale patterns over 14 days |
| **Path-level Affinity** | `github.com/myorg` maps separately from `github.com/trending` for multi-tenant sites |
| **Correction Tracking** | When you rename groups or move tabs before applying, those edits are remembered as 3x signals |
| **Rejection Memory** | When you remove a suggested group, gTabs remembers to avoid that grouping for 30 days |
| **Pattern Mining** | Discovers domains that are frequently grouped together and uses them as co-occurrence hints |
| **Opener Awareness** | New tabs opened from an existing grouped tab prefer joining that group |

### Maintain

| | |
|---|---|
| **Scheduled Re-org** | Daily or weekly automatic re-organization at a configurable time |
| **Pinned Groups** | Mark groups as permanent — they survive re-organization |
| **Group Drift Detection** | Warns when groups become incoherent and may need refreshing |
| **Merge/Split Suggestions** | Detects overlapping groups (>60%) and oversized groups (>10 tabs, >5 domains) |
| **Stale Tab Purge** | Remove inactive tabs older than a configurable threshold |

### Tools

| | |
|---|---|
| **Focus Mode** | Collapses all groups except the active one |
| **Sort Groups** | Alphabetically sorts tabs by domain within each group |
| **Clear Groups** | Ungroups everything in the current window |
| **Duplicate Detection** | Finds tabs with the same URL |
| **Zero-LLM Fast Routing** | Routes new tabs into existing groups via affinity — no API calls |
| **Domain Rules** | Hard-wire `github.com` to `Dev`, always, skipping the LLM entirely |

### Providers

| Provider | Cost | Setup |
|----------|------|-------|
| **Groq** | Free (rate limited) | [Get key](https://console.groq.com/keys) — no credit card |
| **Grok (xAI)** | $25 free credit | [Get key](https://console.x.ai) |
| **OpenRouter** | Free models available | [Get key](https://openrouter.ai/keys) |
| **Ollama** | Free (local) | [Install](https://ollama.com/download) — no key needed |
| **Chrome AI** | Free (local) | Requires Chrome origin trial |
| **Anthropic** | Paid | [Get key](https://console.anthropic.com/settings/keys) |
| **OpenAI** | Paid | [Get key](https://platform.openai.com/api-keys) |

---

## Quick Start

### Install from release

1. Download `gtabs-extension.zip` from [Releases](https://github.com/vaddisrinivas/gtabs/releases)
2. Unzip anywhere
3. Open `chrome://extensions` → enable **Developer mode**
4. **Load unpacked** → select the unzipped folder
5. Pin gTabs to your toolbar

### Build from source

```bash
git clone https://github.com/vaddisrinivas/gtabs.git
cd gtabs
npm install
npm run build    # → dist/
```

### Configure (30 seconds)

1. Click gTabs icon → **Settings**
2. Pick a provider → paste API key → pick model → **Test**
3. Return to popup → **Organize All**

---

## How It Works

```
User clicks "Organize All"
  |
  |-- Domain rules applied instantly (no LLM)
  |
  |-- Smart merge: title-match ungrouped tabs to existing groups
  |
  |-- Remaining tabs sent to LLM with:
  |     |-- Weighted affinity   (github.com -> "Dev" 12x, recent)
  |     |-- Correction signals  (user moved amazon.com to "Shopping" 3x)
  |     |-- Rejection signals   (AVOID: news.com in "Dev")
  |     |-- Co-occurrence       ([github.com, stackoverflow.com] often together)
  |     |-- Opener hints        (Tab 5 opened from Tab 2)
  |     |-- History patterns    (50 past groupings summarized)
  |     '-- Prompt: "Group into max N groups, return JSON"
  |
  |-- Response parsed -> editable suggestion cards shown
  |
  '-- User reviews -> Apply -> chrome.tabs.group()
        |-- Weighted affinity updated (frequency + timestamp)
        |-- Path-level affinity updated for multi-tenant sites
        |-- History recorded, costs tracked
        '-- Corrections captured if user edited before applying
```

---

## Architecture

```
Popup / Options UI
       |
Background Service Worker
   |-- LLM Provider Adapter (OpenAI, Anthropic, Groq, xAI, Ollama, Chrome AI)
   |-- Grouper (prompt builder, parser, domain rules, title matching)
   |-- Storage (weighted affinity, corrections, rejections, co-occurrence, history)
   '-- Chrome APIs (tabs, tabGroups, alarms, storage)
```

| File | Role |
|------|------|
| `types.ts` | All interfaces — weighted affinity, corrections, rejections, settings |
| `storage.ts` | Chrome storage wrapper — migration, decay math, summarizers |
| `grouper.ts` | Prompt builder, JSON parser, title matching, domain rules |
| `llm.ts` | Provider-agnostic LLM client with token counting |
| `background.ts` | Service worker — orchestration, drift detection, scheduled re-org |
| `popup.ts/html` | Action popup — organize, pin, correct, reject, merge/split |
| `options.ts/html` | Settings — providers, learning toggles, schedules, pinned groups |

---

## Settings

### Behavior
- **Max Groups** (2–15) — limit the number of groups AI creates
- **Auto-organize Threshold** (2–25) — trigger when ungrouped tabs exceed this
- **Title Truncation** (20–200) — max tab title chars sent to the LLM
- **Stale Tab Age** (1–168h) — threshold for purging inactive tabs
- **Auto-organize** — silently group when threshold met
- **Protect Existing Groups** — only organize ungrouped tabs
- **Zero-LLM Fast Routing** — route new tabs via affinity, no API calls
- **Auto-pin Web Apps** — pin Gmail, Calendar, Jira, Spotify to the left

### Smart Learning
- **Correction Tracking** — learn from your edits before applying (on by default)
- **Rejection Memory** — remember removed groups and avoid them (on by default)
- **Group Drift Detection** — warn when groups become incoherent
- **Pattern Mining** — discover co-occurring domains from history
- **Drift Threshold** (20–80%) — coherence below which a group is flagged

### Scheduled Re-org
- **Schedule** — Off / Daily / Weekly
- **Time of Day** (0–23) — hour when scheduled re-org runs

### Pinned Groups
- Groups marked as pinned survive all re-organization
- Pin from popup (pin icon on each suggestion card) or settings page

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+G` / `Ctrl+Shift+G` | Organize all tabs |
| `Cmd+Shift+Z` / `Ctrl+Shift+Z` | Undo last grouping |

---

## Development

```bash
npm install          # install dev deps
npm test             # run 287 tests
npm run test:watch   # watch mode
npm run build        # build -> dist/
npm run dev          # watch + rebuild on change
```

---

## Chrome Web Store Submission

### HTTP localhost permission justification

`manifest.json` declares `http://localhost:11434/*` in `host_permissions`. Chrome Web Store policy requires a written justification for plain-HTTP host permissions. Use the following text when submitting:

> "The extension optionally connects to a locally running Ollama instance (http://localhost:11434) for private, on-device LLM inference. This is the only non-HTTPS endpoint and is entirely user-configured. No data leaves the user's machine when this provider is selected."

### Pre-submission checklist

- [ ] HTTP localhost justification included in store listing (see above)
- [ ] `"windows"` permission added to `manifest.json` (required for `chrome.windows.getCurrent()` — see `reports/mv3-audit.md`)
- [ ] Store screenshots match current UI
- [ ] Version bumped in `manifest.json` and `package.json`

---

## Contributing

PRs welcome. Run `npm test` before submitting. Zero runtime dependencies — keep it that way.

## License

MIT
