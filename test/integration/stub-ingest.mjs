// Minimal stand-in for Within's ingestion API. Records every request and
// mimics the per-subject-per-day dedup of /api/sdk/conversions so the
// bridge's deduped/pushed accounting can be asserted end-to-end.
import { createServer } from 'node:http';

const seen = new Set();
export const received = { conversions: [], events: [] };

export function startStubIngest(port = 0) {
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : {};
            if (req.url === '/api/sdk/conversions') {
                received.conversions.push(body);
                const key = `${body.vendor_slug}:${body.subject}:${body.conversion_utc_date}`;
                const inserted = !seen.has(key);
                seen.add(key);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ inserted, status: 'subscriber' }));
            } else if (req.url === '/api/sdk/events') {
                received.events.push(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ accepted: body.events?.length ?? 0 }));
            } else {
                res.writeHead(404).end();
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}
