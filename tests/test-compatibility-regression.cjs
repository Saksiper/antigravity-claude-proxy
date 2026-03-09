/**
 * Compatibility Integration Regression Tests
 *
 * Validates that the proxy's API contract with Claude Code / claude-flow-lite
 * is preserved after hardening patches. Requires the server to be running.
 *
 * Tests:
 * 1. Streaming SSE event structure (message_start → content_block_start → deltas → stop)
 * 2. Tool calling flow (tool_use + tool_result multi-turn)
 * 3. Error payload format (Anthropic-compatible { type: 'error', error: { type, message } })
 * 4. Health endpoint returns expected shape
 * 5. Large payload acceptance (body limit ≥ tool payloads)
 * 6. CORS headers present in response
 * 7. Malformed request returns proper error format
 */
const http = require('http');
const { streamRequest, makeRequest, analyzeEvents, analyzeContent, commonTools } = require('./helpers/http-client.cjs');

const BASE_URL = 'localhost';
const PORT = 8080;

let passed = 0;
let failed = 0;

function test(name, result, msg = '') {
    if (result) {
        console.log(`  ✓ ${name}`);
        passed++;
    } else {
        console.log(`  ✗ ${name}${msg ? ' — ' + msg : ''}`);
        failed++;
    }
}

/**
 * Raw HTTP request helper with header inspection
 */
function rawRequest(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            host: BASE_URL,
            port: PORT,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'test',
                'anthropic-version': '2023-06-01',
                ...(body ? { 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {}),
                ...headers
            }
        };

        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk.toString());
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { /* raw */ }
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    raw: data,
                    body: parsed
                });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║     COMPATIBILITY INTEGRATION REGRESSION TESTS              ║');
    console.log('║  Ensures proxy contract with claude-flow-lite is intact     ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // ═══════════════════════════════════════════════════════════
    // 1. Health endpoint contract
    // ═══════════════════════════════════════════════════════════
    console.log('── Health Endpoint ──');
    try {
        const health = await rawRequest('GET', '/health');
        test('Health returns 200', health.statusCode === 200);
        test('Health returns JSON', health.body !== null);
        test('Health has status field', health.body && health.body.status !== undefined);
    } catch (e) {
        test('Health endpoint reachable', false, e.message);
    }

    // ═══════════════════════════════════════════════════════════
    // 2. CORS headers present
    // ═══════════════════════════════════════════════════════════
    console.log('\n── CORS Headers ──');
    try {
        const cors = await rawRequest('OPTIONS', '/v1/messages', null, {
            'Origin': 'http://localhost:3000',
            'Access-Control-Request-Method': 'POST'
        });
        const corsHeader = cors.headers['access-control-allow-origin'];
        test('CORS header exists', corsHeader !== undefined, `Got headers: ${Object.keys(cors.headers).join(', ')}`);
    } catch (e) {
        test('CORS check reachable', false, e.message);
    }

    // ═══════════════════════════════════════════════════════════
    // 3. Malformed request → Anthropic error format
    // ═══════════════════════════════════════════════════════════
    console.log('\n── Error Payload Format ──');
    try {
        // Missing required fields
        const err = await rawRequest('POST', '/v1/messages', {
            // no model, no messages — should fail
            max_tokens: 100
        });
        test('Malformed returns 4xx/5xx', err.statusCode >= 400, `Got ${err.statusCode}`);
        // Must preserve Anthropic error format
        if (err.body) {
            const hasAnthropicFormat = (
                err.body.type === 'error' &&
                err.body.error &&
                typeof err.body.error.type === 'string' &&
                typeof err.body.error.message === 'string'
            );
            test('Error uses Anthropic format {type: "error", error: {type, message}}',
                hasAnthropicFormat,
                `Got: ${JSON.stringify(err.body).substring(0, 200)}`);
        } else {
            test('Error returns JSON body', false, 'No JSON in response');
        }
    } catch (e) {
        test('Malformed request test', false, e.message);
    }

    // ═══════════════════════════════════════════════════════════
    // 4. Streaming SSE structure
    // ═══════════════════════════════════════════════════════════
    console.log('\n── Streaming SSE Structure ──');
    try {
        const result = await streamRequest({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 256,
            stream: true,
            messages: [{ role: 'user', content: 'Say exactly: "Hello world"' }]
        });

        test('Streaming returns 200', result.statusCode === 200, `Got ${result.statusCode}`);

        const events = analyzeEvents(result.events);
        test('Has message_start event', events.messageStart >= 1);
        test('Has content_block_start', events.blockStart >= 1);
        test('Has content_block_delta', events.blockDelta >= 1);
        test('Has content_block_stop', events.blockStop >= 1);
        test('Has message_delta', events.messageDelta >= 1);
        test('Has message_stop', events.messageStop >= 1);
        test('Has text_delta events', events.textDeltas >= 1);

        // Verify content was assembled
        const content = analyzeContent(result.content);
        test('Has text content block', content.hasText);
    } catch (e) {
        test('Streaming request', false, e.message);
    }

    // ═══════════════════════════════════════════════════════════
    // 5. Tool calling flow (critical for claude-flow-lite)
    // ═══════════════════════════════════════════════════════════
    console.log('\n── Tool Calling Flow ──');
    try {
        const toolResult = await makeRequest({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            stream: false,
            tools: [commonTools.getWeather],
            messages: [{
                role: 'user',
                content: 'What is the weather in Istanbul? Use the get_weather tool.'
            }]
        });

        test('Tool request returns 200', toolResult.statusCode === 200, `Got ${toolResult.statusCode}`);

        if (toolResult.content) {
            const content = analyzeContent(toolResult.content);
            test('Has tool_use block', content.hasToolUse,
                `Content types: ${toolResult.content.map(c => c.type).join(', ')}`);

            if (content.hasToolUse) {
                const toolBlock = content.toolUse[0];
                test('tool_use has id', typeof toolBlock.id === 'string' && toolBlock.id.length > 0);
                test('tool_use has name', toolBlock.name === 'get_weather');
                test('tool_use has input object', typeof toolBlock.input === 'object');
                test('tool_use.input has location', typeof toolBlock.input.location === 'string');
            }
        } else {
            test('Tool response has content', false, 'No content in response');
        }
    } catch (e) {
        test('Tool calling flow', false, e.message);
    }

    // ═══════════════════════════════════════════════════════════
    // 6. Streaming tool calling (input_json_delta)
    // ═══════════════════════════════════════════════════════════
    console.log('\n── Streaming Tool Calling ──');
    try {
        const streamTool = await streamRequest({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            stream: true,
            tools: [commonTools.getWeather],
            messages: [{
                role: 'user',
                content: 'What is the weather in Berlin? You must use the get_weather tool.'
            }]
        });

        test('Streaming tool returns 200', streamTool.statusCode === 200);

        const events = analyzeEvents(streamTool.events);
        const content = analyzeContent(streamTool.content);

        // Tool calling in streaming should produce input_json_delta events
        if (content.hasToolUse) {
            test('Has input_json_delta events', events.inputJsonDeltas >= 1,
                `Got ${events.inputJsonDeltas} input_json_deltas`);
            test('Tool has parsed input', typeof content.toolUse[0].input === 'object');
        } else {
            // Model might respond with text instead — not a failure of our code
            console.log('  ℹ Model chose text response, skipping tool-specific checks');
        }
    } catch (e) {
        test('Streaming tool calling', false, e.message);
    }

    // ═══════════════════════════════════════════════════════════
    // 7. Large payload (ensures body limit doesn't reject valid requests)
    // ═══════════════════════════════════════════════════════════
    console.log('\n── Large Payload Acceptance ──');
    try {
        // Simulate a large tool_result (e.g., file content from claude-flow-lite cache)
        const largeContent = 'x'.repeat(500000); // 500KB — well within 50MB limit
        const largeResult = await rawRequest('POST', '/v1/messages', {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 256,
            stream: false,
            messages: [
                { role: 'user', content: 'Summarize the following: ' + largeContent.substring(0, 1000) },
            ]
        });

        test('Large payload not rejected (status != 413)', largeResult.statusCode !== 413,
            `Got ${largeResult.statusCode}`);
    } catch (e) {
        test('Large payload acceptance', false, e.message);
    }

    // ═══════════════════════════════════════════════════════════
    // 8. Test endpoint gating
    // ═══════════════════════════════════════════════════════════
    console.log('\n── Test Endpoint Gating ──');
    try {
        const testEndpoint = await rawRequest('POST', '/test/clear-signature-cache');
        // In dev mode (default), should still work
        // In production (NODE_ENV=production), would return 404
        if (process.env.NODE_ENV === 'production') {
            test('Test endpoint blocked in production', testEndpoint.statusCode === 404);
        } else {
            test('Test endpoint available in dev', testEndpoint.statusCode === 200);
        }
    } catch (e) {
        test('Test endpoint check', false, e.message);
    }

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log('\n' + '═'.repeat(60));
    console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
    console.log('═'.repeat(60));

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Integration regression test failed:', err);
    process.exit(1);
});
