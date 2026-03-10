/**
 * Session Tracker Module
 *
 * Tracks per-request details during a proxy session:
 * - Which Google account was used
 * - Which model was requested
 * - Success/failure status
 * - Latency, streaming mode, retry count
 *
 * Provides session-level reports complementing claude-flow-lite's
 * operation tracking (which doesn't know about proxy-side details).
 */

import { logger } from '../utils/logger.js';
import { formatDuration } from '../utils/helpers.js';

// ─── In-Memory Session State ────────────────────────────

const session = {
    startTime: Date.now(),
    requests: []
};

/**
 * Track a completed request.
 * @param {object} details
 * @param {string} details.model - Model ID (e.g. "claude-sonnet-4-6-thinking")
 * @param {string} details.account - Account email that served the request
 * @param {boolean} details.stream - Whether streaming was used
 * @param {number} details.status - HTTP status code returned to client
 * @param {number} details.latencyMs - Total request duration in ms
 * @param {number} [details.retryCount=0] - Number of retries before success
 * @param {boolean} [details.fallbackUsed=false] - Whether model fallback was triggered
 * @param {string} [details.errorType] - Error type if request failed
 */
export function trackRequest(details) {
    session.requests.push({
        timestamp: Date.now(),
        model: details.model || 'unknown',
        account: details.account || 'unknown',
        stream: !!details.stream,
        status: details.status || 0,
        latencyMs: details.latencyMs || 0,
        retryCount: details.retryCount || 0,
        fallbackUsed: !!details.fallbackUsed,
        errorType: details.errorType || null
    });
}

/**
 * Generate a session report object.
 * @returns {object} Structured session report
 */
export function getSessionReport() {
    const now = Date.now();
    const durationMs = now - session.startTime;
    const requests = session.requests;
    const total = requests.length;

    if (total === 0) {
        return {
            sessionDuration: formatDuration(durationMs),
            sessionStartTime: new Date(session.startTime).toISOString(),
            totalRequests: 0,
            models: {},
            accounts: {},
            errors: [],
            streaming: { stream: 0, nonStream: 0 },
            avgLatencyMs: 0
        };
    }

    // ─── Model breakdown ─────────────────────────────
    const models = {};
    for (const req of requests) {
        if (!models[req.model]) {
            models[req.model] = { total: 0, success: 0, failed: 0 };
        }
        models[req.model].total++;
        if (req.status >= 200 && req.status < 400) {
            models[req.model].success++;
        } else {
            models[req.model].failed++;
        }
    }

    // Add percentages
    for (const m of Object.values(models)) {
        m.percentage = Math.round((m.total / total) * 100);
    }

    // ─── Account breakdown ───────────────────────────
    const accounts = {};
    for (const req of requests) {
        if (!accounts[req.account]) {
            accounts[req.account] = { total: 0, success: 0, failed: 0, totalLatencyMs: 0 };
        }
        accounts[req.account].total++;
        accounts[req.account].totalLatencyMs += req.latencyMs;
        if (req.status >= 200 && req.status < 400) {
            accounts[req.account].success++;
        } else {
            accounts[req.account].failed++;
        }
    }

    // Calculate averages
    for (const a of Object.values(accounts)) {
        a.avgLatencyMs = Math.round(a.totalLatencyMs / a.total);
        a.avgLatency = formatDuration(a.avgLatencyMs);
        delete a.totalLatencyMs;
    }

    // ─── Errors ──────────────────────────────────────
    const errors = requests
        .filter(r => r.status >= 400)
        .map(r => ({
            timestamp: new Date(r.timestamp).toISOString(),
            model: r.model,
            account: r.account,
            status: r.status,
            errorType: r.errorType
        }));

    // ─── Stream stats ────────────────────────────────
    const streamCount = requests.filter(r => r.stream).length;
    const nonStreamCount = total - streamCount;

    // ─── Average latency ─────────────────────────────
    const avgLatencyMs = Math.round(
        requests.reduce((sum, r) => sum + r.latencyMs, 0) / total
    );

    // ─── Retry stats ─────────────────────────────────
    const totalRetries = requests.reduce((sum, r) => sum + r.retryCount, 0);

    return {
        sessionDuration: formatDuration(durationMs),
        sessionStartTime: new Date(session.startTime).toISOString(),
        totalRequests: total,
        successRate: `${Math.round((requests.filter(r => r.status >= 200 && r.status < 400).length / total) * 100)}%`,
        models,
        accounts,
        errors: errors.length > 0 ? errors : [],
        streaming: { stream: streamCount, nonStream: nonStreamCount },
        avgLatencyMs,
        avgLatency: formatDuration(avgLatencyMs),
        totalRetries
    };
}

/**
 * Generate a human-readable text report.
 * @returns {string} Formatted text report
 */
export function getTextReport() {
    const r = getSessionReport();
    const lines = [];

    lines.push('═══════════════════════════════════════════');
    lines.push('         PROXY SESSION REPORT');
    lines.push('═══════════════════════════════════════════');
    lines.push(`Session: ${r.sessionDuration} | Total: ${r.totalRequests} istek | Başarı: ${r.successRate}`);
    lines.push('');

    // Model breakdown
    if (Object.keys(r.models).length > 0) {
        lines.push('📊 Model Kullanımı:');
        const sorted = Object.entries(r.models).sort((a, b) => b[1].total - a[1].total);
        for (const [model, stats] of sorted) {
            const bar = `${'✅'.repeat(Math.min(stats.success, 10))}${'❌'.repeat(Math.min(stats.failed, 5))}`;
            lines.push(`  ${model.padEnd(32)} ${String(stats.total).padStart(3)} istek (${String(stats.percentage).padStart(2)}%)  ✅ ${stats.success}  ❌ ${stats.failed}`);
        }
        lines.push('');
    }

    // Account breakdown
    if (Object.keys(r.accounts).length > 0) {
        lines.push('👤 Hesap Kullanımı:');
        const sorted = Object.entries(r.accounts).sort((a, b) => b[1].total - a[1].total);
        for (const [email, stats] of sorted) {
            const shortEmail = email.length > 28 ? email.substring(0, 25) + '...' : email;
            lines.push(`  ${shortEmail.padEnd(30)} ${String(stats.total).padStart(3)} istek  ✅ ${String(stats.success).padStart(2)}  ❌ ${String(stats.failed).padStart(2)}  ⏱ ort. ${stats.avgLatency}`);
        }
        lines.push('');
    }

    // Errors
    if (r.errors.length > 0) {
        lines.push(`⚠️  Hatalar (${r.errors.length}):`);
        // Group errors by status
        const byStatus = {};
        for (const e of r.errors) {
            const key = `${e.status} ${e.errorType || ''}`.trim();
            if (!byStatus[key]) byStatus[key] = [];
            byStatus[key].push(e.account);
        }
        for (const [key, accounts] of Object.entries(byStatus)) {
            const unique = [...new Set(accounts)];
            lines.push(`  ${key}: ${accounts.length}x (${unique.join(', ')})`);
        }
        lines.push('');
    }

    // Footer
    lines.push(`Stream: ${r.streaming.stream} | Non-stream: ${r.streaming.nonStream} | Retries: ${r.totalRetries}`);
    lines.push(`Ortalama Latency: ${r.avgLatency}`);
    lines.push('═══════════════════════════════════════════');

    return lines.join('\n');
}

/**
 * Reset the session tracker (start fresh).
 */
export function resetSession() {
    session.startTime = Date.now();
    session.requests = [];
    logger.info('[SessionTracker] Session reset');
}

/**
 * Get raw request log (for debugging).
 * @param {number} [count] - Number of recent entries
 * @returns {Array} Raw request entries
 */
export function getRequestLog(count) {
    if (count) {
        return session.requests.slice(-count);
    }
    return [...session.requests];
}

export default {
    trackRequest,
    getSessionReport,
    getTextReport,
    resetSession,
    getRequestLog
};
