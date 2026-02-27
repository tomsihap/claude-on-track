// ==UserScript==
// @name         Claude On Track
// @namespace    https://claude.ai/
// @version      1.0
// @description  Enhances Claude's Plan Usage page: reset time, budget rate, history, alerts
// @match        https://claude.ai/*
// @grant        GM_info
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY         = 'claude-on-track-history';
    const SESSION_KEY         = 'claude-on-track-session';
    const ALERT_THRESHOLD     = 20;          // % remaining below which we show an alert
    const MIN_SNAPSHOT_MS     = 30 * 60_000; // minimum interval between two snapshots

    // ─── Storage ──────────────────────────────────────────────────────────────

    function loadHistory() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
        catch { return []; }
    }

    function maybeSaveSnapshot(weekResetTs, allModels, sonnet) {
        const history = loadHistory();
        const last = history[history.length - 1];
        if (last && Date.now() - last.ts < MIN_SNAPSHOT_MS) return;
        history.push({ ts: Date.now(), weekResetTs, allModels, sonnet });
        if (history.length > 100) history.splice(0, history.length - 100);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    }

    // Returns stored baseline for this session, or null on first observation (saves baseline).
    function getSessionBaseline(resetTs, currentUsed) {
        try {
            const stored = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
            if (stored && stored.resetTs === resetTs) return stored;
            localStorage.setItem(SESSION_KEY, JSON.stringify({ resetTs, ts: Date.now(), used: currentUsed }));
            return null;
        } catch { return null; }
    }

    // ─── DOM helpers ──────────────────────────────────────────────────────────

    function mkEl(tag, { style = '', text = '', dataset = {} } = {}) {
        const e = document.createElement(tag);
        if (style) e.style.cssText = style;
        if (text)  e.textContent = text;
        Object.entries(dataset).forEach(([k, v]) => { e.dataset[k] = v; });
        return e;
    }

    // ─── Parsers ──────────────────────────────────────────────────────────────

    function parseCountdown(text) {
        const hr  = parseInt((text.match(/(\d+)\s*hr/)  || [, 0])[1]);
        const min = parseInt((text.match(/(\d+)\s*min/) || [, 0])[1]);
        const totalMin = hr * 60 + min;
        return totalMin ? new Date(Date.now() + totalMin * 60_000) : null;
    }

    function fmtHM(d) {
        return `${d.getHours()}h${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function parseWeeklyReset(text) {
        const m = text.match(/Resets\s+(\w+)\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (!m) return null;
        const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const targetDay = dayMap[m[1].slice(0, 3).toLowerCase()];
        if (targetDay === undefined) return null;
        let h = +m[2], mn = +m[3];
        if (m[4].toUpperCase() === 'PM' && h !== 12) h += 12;
        if (m[4].toUpperCase() === 'AM' && h === 12) h = 0;
        const now = new Date();
        const resetDate = new Date(now);
        resetDate.setHours(h, mn, 0, 0);
        let daysUntil = (targetDay - now.getDay() + 7) % 7;
        if (daysUntil === 0 && resetDate <= now) daysUntil = 7;
        resetDate.setDate(resetDate.getDate() + daysUntil);
        return resetDate;
    }

    function findRowContainer(startEl) {
        let node = startEl.parentElement;
        while (node && node !== document.body) {
            const usedEl = Array.from(node.querySelectorAll('p'))
                .find(p => /\d+%\s*used/.test(p.textContent));
            if (usedEl) return { row: node, usedEl };
            node = node.parentElement;
        }
        return null;
    }

    // ─── Feature 4: progress bar colorization ─────────────────────────────────

    function colorizeBar(row, usedPercent) {
        const bar = Array.from(row.querySelectorAll('div[style]'))
            .find(d => /width:\s*\d+%/.test(d.getAttribute('style') || ''));
        if (!bar) return;
        const remaining = 100 - usedPercent;
        bar.style.background =
            remaining > 50 ? '#22c55e' :
            remaining > 20 ? '#f97316' : '#ef4444';
    }

    // ─── Feature 3: usage history sparkline ───────────────────────────────────

    function buildSparkline(weekResetTs, field) {
        const entries = loadHistory().filter(e => e.weekResetTs === weekResetTs);
        if (entries.length < 3) return null;

        const recent = entries.slice(-8);
        const container = mkEl('span', {
            style: 'display:inline-flex;align-items:flex-end;gap:2px;height:14px;margin-left:8px;vertical-align:middle;',
        });

        recent.forEach(e => {
            const pct = (e[field] || 0) / 100;
            const barH = Math.max(2, Math.round(pct * 14));
            const color = pct > 0.8 ? '#ef4444' : pct > 0.5 ? '#f97316' : '#22c55e';
            container.appendChild(mkEl('span', {
                style: `display:inline-block;height:${barH}px;width:4px;border-radius:1px;background:${color};opacity:.75;`,
            }));
        });

        return container;
    }

    // ─── Session info block ───────────────────────────────────────────────────

    function buildSessionBlock(resetDate, used, baseline) {
        const remaining = 100 - used;
        const hoursLeft = (resetDate - Date.now()) / 3_600_000;

        const perHour = hoursLeft > 0.05 ? `~${(remaining / hoursLeft).toFixed(2)}%/h` : '—';
        const timeLeft = hoursLeft >= 1
            ? `in ${hoursLeft.toFixed(1)} h`
            : `in ${Math.round(hoursLeft * 60)} min`;

        // Depletion estimate from observed rate since baseline
        let depletionStr = '';
        if (baseline) {
            const elapsedHours = (Date.now() - baseline.ts) / 3_600_000;
            const usedSince    = used - baseline.used;
            if (elapsedHours > 0.05 && usedSince > 0) {
                const rate = usedSince / elapsedHours;
                const hoursToDepletion = remaining / rate;
                if (hoursToDepletion < hoursLeft) {
                    const depDate = new Date(Date.now() + hoursToDepletion * 3_600_000);
                    depletionStr = `⚠ depleted at ${fmtHM(depDate)}`;
                }
            }
        }

        const isAlert = remaining < ALERT_THRESHOLD;

        const wrapper = mkEl('div', {
            style: 'margin-top:6px;display:flex;flex-direction:column;gap:3px;',
            dataset: { ce: '1' },
        });

        const badge = mkEl('span', {
            style: [
                isAlert
                    ? 'background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);'
                    : 'background:rgba(128,128,128,.1);border:1px solid transparent;',
                'border-radius:5px;padding:2px 8px;font-size:.8em;',
                'display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap;',
            ].join(''),
        });

        if (isAlert) badge.appendChild(mkEl('span', { style: 'color:#ef4444;', text: '⚠' }));
        badge.appendChild(mkEl('span', { text: `${remaining}% remaining · ` }));
        badge.appendChild(mkEl('b', { text: perHour }));
        badge.appendChild(mkEl('span', { style: 'opacity:.6;', text: ` (resets ${timeLeft})` }));
        wrapper.appendChild(badge);

        if (depletionStr) {
            wrapper.appendChild(mkEl('div', {
                style: 'font-size:.75em;color:#ef4444;padding-left:2px;',
                text: depletionStr,
            }));
        }

        return wrapper;
    }

    // ─── Features 1 + 2 + 5: weekly info block ────────────────────────────────

    function buildWeeklyBlock(resetDate, used) {
        const remaining     = 100 - used;
        const hoursLeft     = (resetDate - Date.now()) / 3_600_000;
        const daysLeft      = hoursLeft / 24;
        const totalWeekHours = 7 * 24;
        const elapsedHours  = totalWeekHours - hoursLeft;

        // Feature 2: depletion estimate
        let depletionStr = '';
        if (elapsedHours > 0.5 && used > 0) {
            const rate = used / elapsedHours;
            const hoursToDepletion = remaining / rate;
            if (hoursToDepletion < hoursLeft) {
                const depDate = new Date(Date.now() + hoursToDepletion * 3_600_000);
                depletionStr = hoursToDepletion < 24
                    ? `⚠ depleted at ${fmtHM(depDate)}`
                    : `⚠ depleted in ${(hoursToDepletion / 24).toFixed(1)} d`;
            }
        }

        // Feature 5: ideal vs actual
        const idealUsed = (elapsedHours / totalWeekHours) * 100;
        const delta     = used - idealUsed;
        let idealStr = '';
        if (elapsedHours > 0.5) {
            const paceRatio = Math.round(used / idealUsed * 100);
            if      (Math.abs(delta) < 1) idealStr = '≈ on target';
            else if (delta < 0)           idealStr = `${Math.abs(delta).toFixed(1)} pts below (${paceRatio}% of ideal) ✓`;
            else                          idealStr = `${delta.toFixed(1)} pts above (${paceRatio}% of ideal)`;
        }

        // Budget rates
        const perDay  = daysLeft  > 0.05 ? `~${(remaining / daysLeft).toFixed(1)}%/d`  : '—';
        const perHour = hoursLeft > 0.05 ? `~${(remaining / hoursLeft).toFixed(2)}%/h` : '—';
        const timeLeft = daysLeft >= 1
            ? `in ${daysLeft.toFixed(1)} d`
            : `in ${hoursLeft.toFixed(1)} h`;

        // Feature 1: alert threshold
        const isAlert = remaining < ALERT_THRESHOLD;

        // ── DOM ──────────────────────────────────────────────────────────────
        const wrapper = mkEl('div', {
            style: 'margin-top:6px;display:flex;flex-direction:column;gap:3px;',
            dataset: { ce: '1' },
        });

        // Budget badge
        const badge = mkEl('span', {
            style: [
                isAlert
                    ? 'background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);'
                    : 'background:rgba(128,128,128,.1);border:1px solid transparent;',
                'border-radius:5px;padding:2px 8px;font-size:.8em;',
                'display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap;',
            ].join(''),
        });

        if (isAlert) badge.appendChild(mkEl('span', { style: 'color:#ef4444;', text: '⚠' }));
        badge.appendChild(mkEl('span', { text: `${remaining}% remaining · ` }));
        badge.appendChild(mkEl('b', { text: perDay }));
        badge.appendChild(mkEl('span', { text: ' · ' }));
        badge.appendChild(mkEl('b', { text: perHour }));
        badge.appendChild(mkEl('span', { style: 'opacity:.6;', text: ` (resets ${timeLeft})` }));
        wrapper.appendChild(badge);

        // Ideal vs actual
        if (idealStr) {
            wrapper.appendChild(mkEl('div', {
                style: `font-size:.75em;opacity:.65;padding-left:2px;color:${delta > 5 ? '#f97316' : 'inherit'};`,
                text: idealStr,
            }));
        }

        // Depletion warning
        if (depletionStr) {
            wrapper.appendChild(mkEl('div', {
                style: 'font-size:.75em;color:#ef4444;padding-left:2px;',
                text: depletionStr,
            }));
        }

        return wrapper;
    }

    // ─── Global status badge ──────────────────────────────────────────────────

    function updateGlobalBadge(allModelsUsed, sonnetUsed, weekResetTs) {
        const hoursLeft      = (weekResetTs - Date.now()) / 3_600_000;
        const elapsedHours   = 7 * 24 - hoursLeft;
        const idealUsed      = (elapsedHours / (7 * 24)) * 100;
        const worstUsed      = Math.max(allModelsUsed, sonnetUsed);
        const worstRemaining = 100 - worstUsed;
        const worstDelta     = worstUsed - idealUsed;

        let emoji, label, textColor, bgColor, borderColor;
        if (worstRemaining < ALERT_THRESHOLD) {
            emoji = '🔴'; label = 'Running low';
            textColor = '#ef4444'; bgColor = 'rgba(239,68,68,.1)'; borderColor = 'rgba(239,68,68,.35)';
        } else if (worstDelta > 5) {
            emoji = '🟠'; label = 'Watch out';
            textColor = '#f97316'; bgColor = 'rgba(249,115,22,.1)'; borderColor = 'rgba(249,115,22,.35)';
        } else {
            emoji = '🟢'; label = 'On track';
            textColor = '#22c55e'; bgColor = 'rgba(34,197,94,.1)'; borderColor = 'rgba(34,197,94,.35)';
        }

        const state = worstRemaining < ALERT_THRESHOLD ? 'low' : worstDelta > 5 ? 'warn' : 'ok';

        let badge = document.getElementById('cot-global-badge');
        if (!badge) {
            const heading = Array.from(document.querySelectorAll('h2'))
                .find(h => h.textContent.trim() === 'Plan usage limits');
            if (!heading) return;
            badge = mkEl('span', {
                style: 'margin-left:10px;font-size:.72em;font-weight:500;border-radius:5px;padding:2px 8px;vertical-align:middle;',
            });
            badge.id = 'cot-global-badge';
            heading.appendChild(badge);
        }

        // Avoid re-mutating the DOM (childList) if nothing changed — would re-trigger the MutationObserver.
        // dataset writes are attribute mutations, not childList, so they don't trigger the observer.
        if (badge.dataset.cotState === state) return;
        badge.dataset.cotState = state;

        badge.textContent = `${emoji} ${label}`;
        badge.style.color        = textColor;
        badge.style.background   = bgColor;
        badge.style.border       = `1px solid ${borderColor}`;
    }

    // ─── Main ─────────────────────────────────────────────────────────────────

    // Accumulates data from both weekly rows before saving a snapshot
    const snapshotData = {};

    function enhance() {
        document.querySelectorAll('p').forEach(p => {
            if (p.dataset.ce) return;
            const text = p.textContent.trim();

            // ── Session: "Resets in X hr X min" ───────────────────────────────
            if (/^Resets in \d/.test(text)) {
                p.dataset.ce = '1';
                const resetAt = parseCountdown(text);
                if (resetAt) {
                    p.appendChild(mkEl('span', {
                        style: 'margin-left:8px;opacity:.6;font-size:.88em;',
                        text: `(at ${fmtHM(resetAt)})`,
                    }));

                    const found = findRowContainer(p);
                    if (found) {
                        const { row, usedEl } = found;
                        const usedMatch = usedEl.textContent.match(/(\d+)%/);
                        if (usedMatch) {
                            const used     = +usedMatch[1];
                            const baseline = getSessionBaseline(resetAt.getTime(), used);
                            colorizeBar(row, used);
                            p.after(buildSessionBlock(resetAt, used, baseline));
                        }
                    }
                }
                return;
            }

            // ── Weekly: "Resets Wed 4:00 PM" ──────────────────────────────────
            if (/^Resets\s+\w+\s+\d{1,2}:\d{2}\s+(AM|PM)/i.test(text)) {
                const resetDate = parseWeeklyReset(text);
                if (!resetDate) { p.dataset.ce = '1'; return; }

                const found = findRowContainer(p);
                if (!found) return; // DOM not ready yet → will retry on next mutation

                const { row, usedEl } = found;
                const usedMatch = usedEl.textContent.match(/(\d+)%/);
                if (!usedMatch) return;
                const used = +usedMatch[1];

                p.dataset.ce = '1';

                const weekResetTs = resetDate.getTime();

                // Field name for history storage
                const labelContainer = p.previousElementSibling;
                const labelText = labelContainer?.querySelector('p')?.textContent || '';
                const field = /sonnet/i.test(labelText) ? 'sonnet' : 'allModels';

                // Feature 4: colorize bar
                colorizeBar(row, used);

                // Feature 3: sparkline
                const sparkline = buildSparkline(weekResetTs, field);
                if (sparkline && labelContainer) labelContainer.appendChild(sparkline);

                // Features 1 + 2 + 5: info block
                const weeklyBlock = buildWeeklyBlock(resetDate, used);
                p.after(weeklyBlock);

                snapshotData[field] = { used, weekResetTs, weeklyBlock };
            }
        });

        // Run cross-row features once both rows have been processed
        if (snapshotData.allModels && snapshotData.sonnet) {
            maybeSaveSnapshot(
                snapshotData.allModels.weekResetTs,
                snapshotData.allModels.used,
                snapshotData.sonnet.used,
            );

            // Global status badge
            updateGlobalBadge(
                snapshotData.allModels.used,
                snapshotData.sonnet.used,
                snapshotData.allModels.weekResetTs,
            );

            // Other models breakdown on the allModels block
            const { weeklyBlock } = snapshotData.allModels;
            if (weeklyBlock && !weeklyBlock.querySelector('[data-cot-breakdown]')) {
                const other = snapshotData.allModels.used - snapshotData.sonnet.used;
                if (other > 0) {
                    weeklyBlock.appendChild(mkEl('div', {
                        style: 'font-size:.75em;opacity:.65;padding-left:2px;',
                        text: `~${other}% from other models`,
                        dataset: { cotBreakdown: '1' },
                    }));
                }
            }
        }
    }

    new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true });
    enhance();
})();
