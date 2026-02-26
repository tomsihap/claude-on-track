# Claude On Track

A TamperMonkey userscript that enhances the [Claude.ai](https://claude.ai) Plan Usage Limits page with actionable time and budget information.

## Features

### 1. Session reset — exact time
The countdown "Resets in 4 hr 32 min" is annotated with the actual local clock time.

```
Resets in 4 hr 32 min  (at 14h07)
```

---

### 2. Weekly limits — budget rate
For each weekly limit (All models / Sonnet only), shows how much budget can be spent per day and per hour based on what's left and when the reset happens.

```
Resets Wed 4:00 PM
94% remaining · ~13.4%/d · ~0.56%/h  (resets in 6.8 d)
```

---

### 3. Usage history & sparkline
Every 30 minutes, a snapshot of your current usage is saved to `localStorage`. Once 3+ snapshots are available for the current week, a mini sparkline appears next to the model label, showing your consumption trend.

- Bars are colored green / orange / red based on usage level
- Resets automatically with the weekly period

{{screenshot-sparkline}}

---

### 4. Progress bar colorization
The progress bar fill changes color based on remaining budget:

| Remaining | Color |
|---|---|
| > 50% | Green |
| 20–50% | Orange |
| < 20% | Red |

{{screenshot-bar-color}}

---

### 5. Ideal vs actual consumption
Compares your actual consumption to the theoretically ideal linear pace.

- If 3/7 of the week has elapsed, ideal usage = ~43%
- Shows delta and direction so you know if you're ahead or behind budget

```
6% above ideal pace
```
```
12.3% below ideal pace ✓
```

---

### 6. Depletion alert
If your current consumption rate suggests you'll run out of budget **before** the weekly reset, a warning appears with the estimated depletion time.

```
⚠ depleted at 23h14
⚠ depleted in 2.3 d
```

The budget badge also turns red when less than 20% remains.

---

## Installation

### Prerequisites
- [Brave](https://brave.com), Chrome, or Firefox
- [TamperMonkey](https://www.tampermonkey.net/) extension

### Brave-specific setup (required)
TamperMonkey needs explicit permission to inject scripts in Brave:

1. Go to `brave://extensions`
2. Find **TamperMonkey** → click **Details**
3. Under **Site access**, select **On all sites**

> Without this, TamperMonkey will show the script as "active" but nothing will execute — not even a `console.log`.

### Script installation
1. Open TamperMonkey → **Create a new script**
2. Replace all content with [`script.js`](./script.js)
3. Save (`Ctrl+S` / `Cmd+S`)
4. Navigate to [claude.ai/settings/limits](https://claude.ai/settings/limits)

---

## How it works

| Calculation | Formula |
|---|---|
| Session reset time | `now + countdown duration` |
| % per day | `remaining% ÷ days until weekly reset` |
| % per hour | `remaining% ÷ hours until weekly reset` |
| Ideal usage | `(elapsed hours / 168) × 100%` |
| Depletion estimate | `remaining% ÷ (used% / elapsed hours)` |

The script uses a `MutationObserver` on `document.body` to handle Claude's SPA navigation — it re-runs automatically on every DOM change without requiring a page reload.

Usage history is stored in `localStorage` under the key `claude-on-track-history` as a JSON array of snapshots `{ ts, weekResetTs, allModels, sonnet }`. At most 100 entries are kept, and a new snapshot is saved at most once every 30 minutes.

---

## Compatibility

| Browser | Status | Notes |
|---|---|---|
| Brave | ✓ | Requires "On all sites" site access for TamperMonkey |
| Chrome | ✓ | — |
| Firefox | ✓ | — |
